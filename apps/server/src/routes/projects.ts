// 프로젝트 REST API. 화면의 일부 기능과 MCP(AI)가 이 API를 쓴다.

import type { FastifyInstance } from 'fastify';
import {
  appliedChanges,
  buildReview,
  resolveReviewItems,
  unreviewedTables,
  type AiReviewInput,
  applyChanges,
  applyCommands,
  CommandError,
  diffIncoming,
  diffSchemas,
  emptySchema,
  generateStatements,
  getDialect,
  parseDdl,
  placeNewTables,
  planPull,
  planPush,
  summarizePlan,
  syncedBaseline,
  toLink,
  requireArea,
  areaSchema,
  setAreaPosition,
  toScript,
  changeImpact,
  syncDictionaryForAi,
  addMissingTerms,
  readDictionary,
  readNotes,
  addNote,
  updateNote,
  removeNote,
  areaPosition,
  estimateTableSize,
  type Change,
  type ChangeCategory,
  type Command,
  dialects,
  type DialectId,
  type RenameLink,
  type Schema,
  type SyncPlan,
} from '@erd/core';
import { autoLayout } from '@erd/core/layout';
import { buildDefinitionXlsx } from '@erd/core/excel';
import { getConnector } from '@erd/db';
import type { ConnectionStore } from '../connections';
import type { Origin, ProjectStore } from '../projects';
import { DESKTOP_ONLY_MESSAGE, type Auth } from '../auth';

const DIALECTS = Object.keys(dialects) as DialectId[];
/** 이 시간 동안 AI 변경이 없으면 다음 변경은 새 AI 작업으로 본다 (되돌리기 기준 버전을 새로 만든다) */
const AI_SESSION_IDLE_MS = 30 * 60 * 1000;

type Mode = 'apply' | 'propose';
const AREA_OPS = new Set(['createArea', 'updateArea', 'dropArea', 'addToArea', 'removeFromArea', 'moveToArea']);
type Source = 'user' | 'ai' | 'api';

const badRequest = (message: string) => Object.assign(new Error(message), { statusCode: 400 });

function summarize(changes: { id: string; category: ChangeCategory; tableName: string; summary: string; warning?: string }[]) {
  return changes.map(({ id, category, tableName, summary, warning }) => ({ id, category, tableName, summary, warning }));
}

export function registerProjectRoutes(
  app: FastifyInstance,
  store: ProjectStore,
  connections: ConnectionStore,
  executeLog: (entry: object) => void,
  auth: Auth,
  serverDb = true,
) {
  const desktopOnly = () => Object.assign(new Error(DESKTOP_ONLY_MESSAGE), { statusCode: 403 });
  /**
   * 스키마 변경을 적용한다.
   * - mode=apply: 바로 문서에 반영. AI가 바꾸면 작업 시작 전 버전을 자동 저장해 한 번에 되돌릴 수 있게 한다.
   * - mode=propose: 문서는 그대로 두고 제안으로 모은다. 사람이 화면에서 검토 후 반영한다.
   */
  function change(id: string, next: Schema, options: { mode: Mode; source: Source; title: string; messages: string[]; origin?: Origin }) {
    const before = store.schema(id);
    const dialect = getDialect(store.dialect(id));
    if (options.mode === 'propose') {
      const proposal = store.upsertProposal(id, options.source === 'ai' ? 'ai' : 'api', options.title, (target) => {
        // 제안 대상에도 같은 변경을 적용한다 (before→next 차이를 target에 반영)
        const diff = diffSchemas(before, next, dialect);
        return { schema: applyChanges(target, diff), messages: options.messages };
      });
      return {
        mode: 'propose' as const,
        proposalId: proposal.id,
        messages: options.messages,
        pendingChanges: summarize(store.proposalChanges(id, proposal)),
      };
    }
    const changes = diffSchemas(before, next, dialect).changes;
    if (options.source === 'ai' && changes.length) {
      const meta = store.meta(id);
      const now = new Date();
      const session = meta.aiSession;
      if (!session || now.getTime() - new Date(session.lastAt).getTime() > AI_SESSION_IDLE_MS) {
        const version = store.saveVersion(id, `AI 작업 전 · ${now.toLocaleString('ko-KR')}`, 'auto', before);
        store.setMeta(id, { aiSession: { versionId: version.id, startedAt: now.toISOString(), lastAt: now.toISOString(), changeCount: changes.length } });
      } else {
        store.setMeta(id, { aiSession: { ...session, lastAt: now.toISOString(), changeCount: session.changeCount + changes.length } });
      }
    }
    if (options.source === 'ai' && changes.length) store.pushAiStep(id, before, next);
    store.setSchema(id, next, options.origin ?? (options.source === 'ai' ? 'ai' : 'api'));
    return { mode: 'apply' as const, messages: options.messages, changes: summarize(changes) };
  }

  function reviewNotes(id: string, before: Schema, after: Schema) {
    const impact = changeImpact(before, after);
    const dictionary = syncDictionaryForAi(readDictionary(store.load(id).doc), before, after).notes;
    return { ...(impact.length ? { impact } : {}), ...(dictionary.length ? { dictionary } : {}) };
  }

  /**
   * AI가 만든 컬럼 중 사전에 없는 용어를 사전에 넣는다 (사전이 있을 때만).
   * 같은 논리명·물리명이 이미 있으면 넣지 않고, 사전 표기와 다른 이름은 넣지 않는다. 넣은 용어 "논리명=물리명"
   */
  function addAiTerms(id: string, before: Schema, after: Schema): string[] {
    const { doc } = store.load(id);
    const { add } = syncDictionaryForAi(readDictionary(doc), before, after);
    if (!add.length) return [];
    let added: { logical: string; physical: string }[] = [];
    doc.transact(() => {
      added = addMissingTerms(doc, add);
    }, 'ai');
    return added.map((t) => `${t.logical}=${t.physical}`);
  }

  const modeOf = (id: string, mode: unknown, source: Source): Mode => {
    // 프로젝트가 제안 모드면 AI 변경은 항상 사람 승인을 거친다 (AI가 apply를 요청해도 제안으로 받는다)
    if (source === 'ai' && store.meta(id).aiMode === 'propose') return 'propose';
    if (mode === 'apply' || mode === 'propose') return mode;
    return 'apply';
  };

  // ── 표준 용어 사전 (MCP가 읽는다. 화면은 문서로 직접 읽고 쓴다) ─────────────
  app.get<{ Params: { id: string } }>('/api/projects/:id/dictionary', async (req) => ({ dictionary: readDictionary(store.load(req.params.id).doc) }));

  // ── 캔버스 메모 (ERD 구조와 따로 저장. SQL·DB에는 영향 없음) ─────────────
  type NoteBody = { text?: string; area?: string | null; color?: string; x?: number; y?: number; width?: number; height?: number; source?: Source };
  const noteView = (id: string) => {
    const schema = store.schema(id);
    const names = new Map((schema.areas ?? []).map((a) => [a.id, a.name]));
    return readNotes(store.load(id).doc).map((n) => ({ ...n, area: n.areaId ? names.get(n.areaId) : undefined }));
  };
  app.get<{ Params: { id: string } }>('/api/projects/:id/notes', async (req) => ({ notes: noteView(req.params.id) }));
  app.post<{ Params: { id: string }; Body: NoteBody }>('/api/projects/:id/notes', async (req) => {
    const { id } = req.params;
    const body = req.body ?? {};
    if (!body.text?.trim()) throw badRequest('메모 내용(text)이 필요합니다');
    const schema = store.schema(id);
    let areaId: string | undefined;
    try {
      areaId = body.area ? requireArea(schema, body.area).id : undefined;
    } catch (e) {
      throw badRequest(e instanceof Error ? e.message : String(e));
    }
    // 위치를 안 주면 그 탭 테이블들의 오른쪽 위에
    let position = { x: body.x ?? 0, y: body.y ?? 0 };
    if (body.x === undefined || body.y === undefined) {
      const area = areaId ? schema.areas!.find((a) => a.id === areaId) : undefined;
      const tables = area ? schema.tables.filter((t) => area.tableIds.includes(t.id)) : schema.tables;
      const boxes = tables.map((t) => ({ p: area ? areaPosition(area, t) : t.position, s: estimateTableSize(t) }));
      position = boxes.length ? { x: Math.max(...boxes.map((b) => b.p.x + b.s.width)) + 80, y: Math.min(...boxes.map((b) => b.p.y)) } : { x: 0, y: 0 };
    }
    const { doc } = store.load(id);
    let noteId = '';
    doc.transact(() => {
      noteId = addNote(doc, { text: body.text!.trim(), position, width: body.width, height: body.height, color: body.color, areaId, author: body.source === 'ai' ? 'AI' : undefined });
    }, body.source === 'ai' ? 'ai' : 'api');
    return noteView(id).find((n) => n.id === noteId);
  });
  app.patch<{ Params: { id: string; nid: string }; Body: NoteBody }>('/api/projects/:id/notes/:nid', async (req) => {
    const { id, nid } = req.params;
    const b = req.body ?? {};
    const { doc } = store.load(id);
    const current = readNotes(doc).find((n) => n.id === nid);
    if (!current) throw Object.assign(new Error('메모를 찾을 수 없습니다'), { statusCode: 404 });
    doc.transact(() => updateNote(doc, nid, {
      text: b.text,
      color: b.color,
      width: b.width,
      height: b.height,
      position: b.x !== undefined || b.y !== undefined ? { x: b.x ?? current.position.x, y: b.y ?? current.position.y } : undefined,
    }), b.source === 'ai' ? 'ai' : 'api');
    return noteView(id).find((n) => n.id === nid);
  });
  app.delete<{ Params: { id: string; nid: string } }>('/api/projects/:id/notes/:nid', async (req) => {
    const { doc } = store.load(req.params.id);
    if (!readNotes(doc).some((n) => n.id === req.params.nid)) throw Object.assign(new Error('메모를 찾을 수 없습니다'), { statusCode: 404 });
    doc.transact(() => removeNote(doc, req.params.nid), 'api');
    return { ok: true };
  });

  // ── 프로젝트 ─────────────────────────────
  app.get('/api/projects', async (req) =>
    store
      .list()
      .map((p) => ({ ...p, role: auth.role(p.id, req.user.id) }))
      .filter((p) => p.role !== null),
  );

  app.post<{ Body: { name?: string; dialect?: DialectId; schema?: Schema } }>('/api/projects', async (req) => {
    const dialect = req.body?.dialect ?? 'mysql';
    if (!DIALECTS.includes(dialect)) throw badRequest('DB 종류가 올바르지 않습니다');
    const project = store.create(req.body?.name?.trim() || '새 프로젝트', dialect, req.body?.schema ?? emptySchema());
    auth.initProject(project.id, req.user.id);
    return { ...project, role: 'owner' };
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id', async (req) => ({ ...store.get(req.params.id), role: auth.role(req.params.id, req.user.id) }));

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/projects/:id', async (req) => {
    const b = req.body ?? {};
    const patch: Record<string, unknown> = {};
    if (typeof b.name === 'string' && b.name.trim()) patch.name = b.name.trim();
    if (DIALECTS.includes(b.dialect as DialectId)) patch.dialect = b.dialect;
    if (b.aiMode === 'apply' || b.aiMode === 'propose') patch.aiMode = b.aiMode;
    if (typeof b.aiAllowDbExecute === 'boolean') {
      // AI에게 DB 실행을 허용하는 것은 소유자만
      if (auth.role(req.params.id, req.user.id) !== 'owner') throw Object.assign(new Error('AI의 DB 실행 허용은 프로젝트 소유자만 바꿀 수 있습니다'), { statusCode: 403 });
      patch.aiAllowDbExecute = b.aiAllowDbExecute;
    }
    if (b.dbConnectionId === null || typeof b.dbConnectionId === 'string') {
      // 연결 id는 '이 프로젝트에서 고른 연결'을 기억하는 것뿐이라 서버 연결 목록에서 확인하지 않는다.
      // 설치형 앱의 연결은 그 PC에만 있어 서버(로컬·자체 설치)에 없을 수 있다. 실제 DB 작업은 할 때마다 연결 주인을 다시 확인한다.
      if (typeof b.dbConnectionId === 'string' && b.dbConnectionId.length > 100) throw badRequest('잘못된 연결 id');
      patch.dbConnectionId = b.dbConnectionId;
    }
    return store.setMeta(req.params.id, patch);
  });

  // ── AI 설계 검토 ───────────────────────────
  // MCP로 연결한 AI가 검토한 결과(오류·경고·참고)를 저장한다. 화면의 설계 검사 패널에 기본 검사와 함께 보인다.
  app.put<{ Params: { id: string }; Body: { items?: AiReviewInput[]; summary?: string; by?: string; scope?: string[] } }>('/api/projects/:id/ai-review', async (req) => {
    const { id } = req.params;
    let review;
    try {
      const scope = Array.isArray(req.body?.scope) ? req.body.scope.filter((x): x is string => typeof x === 'string') : undefined;
      review = buildReview(store.schema(id), { items: req.body?.items ?? [], summary: req.body?.summary, by: req.body?.by, scope }, store.meta(id).aiReview);
    } catch (e) {
      throw badRequest(e instanceof Error ? e.message : String(e));
    }
    store.setMeta(id, { aiReview: review });
    const ignored = new Set(store.meta(id).lintIgnored ?? []);
    const open = review.items.filter((i) => i.status === 'open');
    return { reviewedAt: review.reviewedAt, saved: open.length, ignored: open.filter((i) => ignored.has(i.id)).map((i) => i.id), items: open, stillUnreviewed: unreviewedTables(store.schema(id), review) ?? [] };
  });

  /** AI가 고친 검토 항목을 해결됨으로 표시 */
  app.post<{ Params: { id: string }; Body: { ids?: string[]; resolution?: string } }>('/api/projects/:id/ai-review/resolve', async (req) => {
    const { id } = req.params;
    const current = store.meta(id).aiReview;
    if (!current) throw badRequest('저장된 AI 검토가 없습니다');
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((x): x is string => typeof x === 'string') : [];
    if (!ids.length) throw badRequest('ids가 필요합니다');
    const { review, resolved, unknown } = resolveReviewItems(current, ids, req.body?.resolution);
    store.setMeta(id, { aiReview: review });
    return { resolved, unknown };
  });

  app.delete<{ Params: { id: string } }>('/api/projects/:id', async (req) => {
    store.remove(req.params.id);
    return { ok: true };
  });

  app.put<{ Params: { id: string }; Body: { schema: Schema } }>('/api/projects/:id/schema', async (req) => {
    if (!req.body?.schema?.tables) throw badRequest('schema가 필요합니다');
    store.setSchema(req.params.id, req.body.schema, 'api');
    return { ok: true };
  });

  // ── 명령 (MCP가 주로 쓴다) ─────────────────────────────
  app.post<{ Params: { id: string }; Body: { commands: Command[]; mode?: Mode; source?: Source; title?: string } }>(
    '/api/projects/:id/commands',
    async (req) => {
      const { id } = req.params;
      const { commands, source = 'api', title = 'AI 제안' } = req.body ?? ({} as never);
      if (!Array.isArray(commands) || !commands.length) throw badRequest('commands가 필요합니다');
      let mode = modeOf(id, req.body.mode, source);
      // 영역 명령만 있으면 제안 없이 바로 반영한다 (화면에서 나눠 보는 구분일 뿐 설계·DB는 바뀌지 않음).
      // 아직 제안에만 있는 테이블을 가리키면 제안에 이어서 넣는다
      if (mode === 'propose' && commands.every((c) => AREA_OPS.has(c?.op))) {
        try {
          const direct = applyCommands(store.schema(id), commands);
          return change(id, direct.schema, { mode: 'apply', source, title, messages: [...direct.messages, '영역은 화면에서 나눠 보는 구분이라 제안 없이 바로 반영했습니다'] });
        } catch (e) {
          if (!(e instanceof CommandError)) throw e;
        }
      }
      // 제안 모드에서는 지금까지 모은 제안 위에 이어서 적용한다
      const base = mode === 'propose' ? (store.proposals(id).find((p) => p.status === 'pending' && p.source === (source === 'ai' ? 'ai' : 'api'))?.target ?? store.schema(id)) : store.schema(id);
      let result;
      try {
        result = applyCommands(base, commands);
      } catch (e) {
        if (e instanceof CommandError) throw badRequest(e.message);
        throw e;
      }
      // 함께 바뀐 것(영향도)과 표준 용어 사전과 다른 컬럼을 알려 준다 (AI가 바로 이어서 고치게)
      const extra = reviewNotes(id, base, result.schema);
      if (mode === 'propose') {
        const proposal = store.upsertProposal(id, source === 'ai' ? 'ai' : 'api', title, () => ({ schema: result.schema, messages: result.messages }));
        // 사전에 없는 용어는 사람이 제안을 승인할 때 사전에 넣는다
        return { mode, proposalId: proposal.id, messages: result.messages, pendingChanges: summarize(store.proposalChanges(id, proposal)), ...extra };
      }
      const applied = change(id, result.schema, { mode, source, title, messages: result.messages });
      const dictionaryAdded = source === 'ai' ? addAiTerms(id, base, result.schema) : [];
      return { ...applied, ...extra, ...(dictionaryAdded.length ? { dictionaryAdded } : {}) };
    },
  );

  app.post<{ Params: { id: string }; Body: { sql: string; mode?: Mode; source?: Source; dialect?: DialectId | 'auto' } }>(
    '/api/projects/:id/import-ddl',
    async (req) => {
      const { id } = req.params;
      const { sql, source = 'api' } = req.body ?? ({} as never);
      if (!sql?.trim()) throw badRequest('sql이 필요합니다');
      const current = store.schema(id);
      const parsed = parseDdl(sql, { dialect: req.body.dialect ?? 'auto', context: current });
      const diff = diffIncoming(current, parsed.schema, getDialect(parsed.dialect));
      // DDL에 없는 테이블은 지우지 않는다
      const selected = new Set(diff.changes.filter((c) => c.kind !== 'dropTable' && c.kind !== 'dropForeignKey').map((c) => c.id));
      const next = applyChanges(current, diff, selected);
      placeNewTables(next, diff.changes.flatMap((c) => (c.kind === 'createTable' && selected.has(c.id) ? [c.table.id] : [])));
      const result = change(id, next, { mode: modeOf(id, req.body.mode, source), source, title: 'DDL 가져오기', messages: [`DDL에서 테이블 ${parsed.schema.tables.length}개 읽음`] });
      return { ...result, warnings: parsed.warnings };
    },
  );

  // ── AI 작업 되돌리기 ─────────────────────────────
  // scope=last(기본, MCP): 가장 최근 AI 작업 한 번만 거꾸로 되돌린다. 그 뒤 사람이 고친 다른 부분은 그대로 둔다.
  // scope=session(화면의 AI 배너): 이번 AI 작업 묶음 전체를 작업 전 버전으로 되돌린다.
  app.post<{ Params: { id: string }; Body: { scope?: 'last' | 'session' } }>('/api/projects/:id/ai/undo', async (req) => {
    const { id } = req.params;
    if (req.body?.scope === 'session') {
      const session = store.meta(id).aiSession;
      if (!session) throw badRequest('되돌릴 AI 작업이 없습니다');
      const version = store.version(id, session.versionId);
      store.saveVersion(id, `AI 변경 되돌리기 전`, 'auto');
      store.setSchema(id, version.schema, 'restore');
      store.setMeta(id, { aiSession: null });
      store.clearAiSteps(id);
      return { ok: true, restoredVersion: version.name };
    }
    const step = store.popAiStep(id);
    if (!step) throw badRequest('되돌릴 AI 작업이 없습니다');
    const dialect = getDialect(store.dialect(id));
    const reverse = diffSchemas(step.after, step.before, dialect);
    store.saveVersion(id, `AI 변경 되돌리기 전`, 'auto');
    store.setSchema(id, applyChanges(store.schema(id), reverse), 'restore');
    const session = store.meta(id).aiSession;
    if (session) {
      const left = Math.max(0, session.changeCount - reverse.changes.length);
      store.setMeta(id, { aiSession: left ? { ...session, changeCount: left } : null });
    }
    return { ok: true, undone: summarize(reverse.changes), at: step.at };
  });

  app.post<{ Params: { id: string } }>('/api/projects/:id/ai/accept', async (req) => {
    store.setMeta(req.params.id, { aiSession: null });
    return { ok: true };
  });

  // ── 버전 ─────────────────────────────
  app.get<{ Params: { id: string } }>('/api/projects/:id/versions', async (req) =>
    store.versions(req.params.id).map(({ schema, ...v }) => ({ ...v, tableCount: schema.tables.length })),
  );
  app.get<{ Params: { id: string; vid: string } }>('/api/projects/:id/versions/:vid', async (req) => store.version(req.params.id, req.params.vid));
  /**
   * 버전 저장. 화면은 저장할 스키마(schema)를 함께 보낸다.
   * 화면의 편집은 WebSocket으로, 이 요청은 HTTP로 오기 때문에 서버 문서가 아직 최신이 아닐 수 있어서다.
   */
  app.post<{ Params: { id: string }; Body: { name?: string; source?: 'manual' | 'auto' | 'db' | 'ai'; schema?: Schema } }>('/api/projects/:id/versions', async (req) => {
    const schema = req.body?.schema;
    if (schema !== undefined && (!Array.isArray(schema?.tables) || !Array.isArray(schema?.relations))) throw badRequest('schema 형식이 올바르지 않습니다');
    const v = store.saveVersion(req.params.id, req.body?.name?.trim() || new Date().toLocaleString('ko-KR'), req.body?.source ?? 'manual', schema);
    return { ...v, schema: undefined, tableCount: v.schema.tables.length };
  });
  app.delete<{ Params: { id: string; vid: string } }>('/api/projects/:id/versions/:vid', async (req) => {
    store.deleteVersion(req.params.id, req.params.vid);
    return { ok: true };
  });
  app.post<{ Params: { id: string; vid: string } }>('/api/projects/:id/versions/:vid/restore', async (req) => {
    const { id, vid } = req.params;
    const version = store.version(id, vid);
    store.saveVersion(id, `복원 전 (→ ${version.name})`, 'auto');
    store.setSchema(id, version.schema, 'restore');
    return { ok: true };
  });
  /** 두 버전(또는 버전과 지금) 비교. to를 비우면 지금 ERD */
  app.get<{ Params: { id: string }; Querystring: { from: string; to?: string } }>('/api/projects/:id/diff', async (req) => {
    const { id } = req.params;
    const from = store.version(id, req.query.from).schema;
    const to = req.query.to ? store.version(id, req.query.to).schema : store.schema(id);
    return summarize(diffSchemas(from, to, getDialect(store.dialect(id))).changes);
  });

  // ── 제안 ─────────────────────────────
  app.get<{ Params: { id: string } }>('/api/projects/:id/proposals', async (req) => {
    const { id } = req.params;
    return store.proposals(id).map((p) => ({
      id: p.id, title: p.title, source: p.source, status: p.status, createdAt: p.createdAt, updatedAt: p.updatedAt, messages: p.messages,
      changes: p.status === 'pending' ? summarize(store.proposalChanges(id, p)) : [],
    }));
  });
  app.get<{ Params: { id: string; pid: string } }>('/api/projects/:id/proposals/:pid', async (req) => {
    const p = store.proposal(req.params.id, req.params.pid);
    return { ...p, changes: summarize(store.proposalChanges(req.params.id, p)) };
  });
  app.post<{ Params: { id: string; pid: string }; Body: { selected?: string[] } }>('/api/projects/:id/proposals/:pid/apply', async (req) => {
    const { id, pid } = req.params;
    const before = store.schema(id);
    const fromAi = store.proposals(id).find((p) => p.id === pid)?.source === 'ai';
    const applied = store.applyProposal(id, pid, req.body?.selected);
    // AI 제안이면 승인한 컬럼 중 사전에 없는 용어를 사전에 넣는다
    const dictionaryAdded = fromAi ? addAiTerms(id, before, store.schema(id)) : [];
    return { ok: true, applied: summarize(applied), ...(dictionaryAdded.length ? { dictionaryAdded } : {}) };
  });
  app.post<{ Params: { id: string; pid: string } }>('/api/projects/:id/proposals/:pid/reject', async (req) => {
    store.rejectProposal(req.params.id, req.params.pid);
    return { ok: true };
  });

  // ── SQL / 배치 / 정의서 ─────────────────────────────
  app.get<{ Params: { id: string }; Querystring: { dialect?: DialectId; since?: string } }>('/api/projects/:id/sql', async (req) => {
    const { id } = req.params;
    const dialect = getDialect(req.query.dialect ?? store.dialect(id));
    const base = req.query.since ? store.version(id, req.query.since).schema : emptySchema();
    const diff = diffSchemas(base, store.schema(id), dialect);
    const statements = generateStatements(diff, dialect);
    return { dialect: dialect.id, changes: summarize(diff.changes), statements, script: toScript(statements) };
  });

  /** 자동 배치. area(이름 또는 id)를 주면 그 주제영역 탭의 배치만 정리한다 (전체 ERD 배치는 그대로) */
  app.post<{ Params: { id: string }; Body: { area?: string } }>('/api/projects/:id/layout', async (req) => {
    const { id } = req.params;
    const schema = store.schema(id);
    if (req.body?.area) {
      let area;
      try {
        area = requireArea(schema, req.body.area);
      } catch (e) {
        throw badRequest(e instanceof Error ? e.message : String(e));
      }
      const positions = await autoLayout(areaSchema(schema, area.id).schema);
      for (const [tableId, p] of positions) setAreaPosition(schema, area.id, tableId, p);
      store.setSchema(id, schema, 'api');
      return { ok: true, area: area.name, tables: area.tableIds.length };
    }
    const positions = await autoLayout(schema);
    for (const t of schema.tables) t.position = positions.get(t.id) ?? t.position;
    store.setSchema(id, schema, 'api');
    return { ok: true };
  });

  app.get<{ Params: { id: string }; Querystring: { layout?: 'sheetPerTable' | 'singleSheet'; author?: string; since?: string; area?: string } }>(
    '/api/projects/:id/definition.xlsx',
    async (req, reply) => {
      const { id } = req.params;
      const meta = store.meta(id);
      const schema = store.schema(id);
      const since = req.query.since ? store.version(id, req.query.since) : undefined;
      // area: 그 주제영역 테이블만 (이름 또는 id)
      let area;
      try {
        area = req.query.area ? requireArea(schema, req.query.area) : undefined;
      } catch (e) {
        throw badRequest(e instanceof Error ? e.message : String(e));
      }
      const buffer = await buildDefinitionXlsx(schema, {
        ...(area ? { tableIds: area.tableIds, scopeLabel: `${area.name} 영역` } : {}),
        projectName: meta.name,
        dialect: meta.dialect as DialectId,
        author: req.query.author,
        layout: req.query.layout,
        changes: since ? { title: `변경 이력 ("${since.name}" 이후)`, items: diffSchemas(since.schema, schema, getDialect(meta.dialect as DialectId)).changes } : undefined,
      });
      reply
        .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${meta.name}${area ? `_${area.name}` : ''}_테이블정의서.xlsx`)}`);
      return reply.send(Buffer.from(buffer));
    },
  );

  // ── DB 연동 ─────────────────────────────
  // 3방향 비교의 기준 시점(마지막으로 DB와 맞춘 상태)을 프로젝트·연결별로 저장해 두고, 비교할 때 쓴다.

  const STATUS_CACHE_MS = 60_000;
  const statusCache = new Map<string, { at: number; name: string; database: string; dialect: ReturnType<typeof getDialect>; schema: Schema }>();

  async function readDb(id: string, connectionId: string, userId: string) {
    if (!serverDb) throw desktopOnly();
    const saved = connections.get(connectionId, userId);
    const config = connections.config(connectionId, userId);
    await auth.assertAllowedDbHost(config.host);
    const db = await getConnector(config.dialect).introspect(config);
    // 이 프로젝트가 어느 DB와 연결돼 있는지 기억한다 (다른 사람·AI·차이 알림이 같은 DB를 본다)
    if (store.meta(id).dbConnectionId !== connectionId) store.setMeta(id, { dbConnectionId: connectionId });
    return { saved, config, dialect: getDialect(config.dialect), db };
  }

  /** 지금 DB 상태를 기준 시점으로 저장한다 (가져오기·내보내기 직후) */
  async function markSynced(id: string, connectionId: string, userId: string, applied: Change[] = []) {
    const { db } = await readDb(id, connectionId, userId);
    const previous = store.baseline(id, connectionId)?.schema;
    return store.setBaseline(id, connectionId, syncedBaseline(db.schema, store.schema(id), { applied, previous }));
  }

  /** 이름 변경 후보 중 받아들일 것: true면 전부, 배열이면 그 id만 */
  function acceptedLinks(plan: SyncPlan, accept: boolean | string[] | undefined): RenameLink[] {
    if (!accept) return [];
    return plan.renames.filter((r) => accept === true || accept.includes(r.id)).map(toLink);
  }

  function describePlan(plan: SyncPlan) {
    return {
      hasBaseline: plan.hasBaseline,
      summary: summarizePlan(plan),
      changes: plan.diff.changes.map((c) => ({ ...summarize([c])[0], origin: plan.origins[c.id], selected: plan.defaultSelected.has(c.id) })),
      renames: plan.renames.map(({ id, kind, tableName, dbName, erdName }) => ({ id, kind, tableName, dbName, erdName })),
    };
  }

  app.get<{ Params: { id: string }; Querystring: { connectionId: string } }>('/api/projects/:id/db/baseline', async (req) => ({
    baseline: store.baseline(req.params.id, req.query.connectionId),
  }));

  /** 기준 시점 저장. 화면은 자기가 본 DB 구조(ERD id로 맞춘 것)를 보낸다 — 화면 편집이 서버에 도착하기 전이어도 정확하도록 */
  app.post<{ Params: { id: string }; Body: { connectionId: string; schema?: Schema } }>('/api/projects/:id/db/baseline', async (req) => {
    const { id } = req.params;
    const { connectionId, schema } = req.body ?? ({} as never);
    // 화면(설치형 앱)이 자기가 읽은 DB 구조를 보내면 그대로 저장한다. 앱의 연결은 그 PC에만 있어서 서버 연결 목록에 없을 수 있다
    // (서버가 DB에 접속하는 로컬·자체 설치 서버에 앱을 붙여 쓸 때). 구조를 안 보내면 서버가 직접 DB를 읽어야 한다.
    if (!schema) {
      if (!serverDb) throw desktopOnly();
      connections.get(connectionId, req.user.id);
    }
    if (typeof connectionId !== 'string' || !connectionId || connectionId.length > 100) throw badRequest('connectionId가 필요합니다');
    if (schema !== undefined && (!Array.isArray(schema?.tables) || !Array.isArray(schema?.relations))) throw badRequest('schema 형식이 올바르지 않습니다');
    statusCache.delete(`${id}:${connectionId}`);
    const b = schema ? store.setBaseline(id, connectionId, schema) : await markSynced(id, connectionId, req.user.id);
    return { at: b.at };
  });

  /** DB와 얼마나 다른지 (차이 알림 배지용) */
  app.get<{ Params: { id: string }; Querystring: { connectionId?: string } }>('/api/projects/:id/db/status', async (req) => {
    const { id } = req.params;
    const connectionId = req.query.connectionId || store.meta(id).dbConnectionId;
    if (!connectionId) return { connected: false };
    // 서버가 DB에 접속하지 않는 배포 환경: 차이 확인은 설치형 앱이 한다
    if (!serverDb) return { connected: false, reason: 'desktop' };
    // 연결은 만든 사람만 쓸 수 있다. 함께 작업하는 다른 사람에게는 상태를 보여주지 않는다.
    try {
      connections.get(connectionId, req.user.id);
    } catch {
      return { connected: false, reason: '이 프로젝트에 연결된 DB는 다른 사람의 연결입니다' };
    }
    // 여러 사람이 같은 프로젝트를 열어도 DB를 자주 읽지 않도록 잠시 기억한다 (DB 구조만, ERD 비교는 매번 새로)
    const key = `${id}:${connectionId}`;
    let cached = statusCache.get(key);
    if (!cached || Date.now() - cached.at > STATUS_CACHE_MS) {
      const { saved, dialect, db } = await readDb(id, connectionId, req.user.id);
      cached = { at: Date.now(), name: saved.name, database: saved.database, dialect, schema: db.schema };
      statusCache.set(key, cached);
    }
    const baseline = store.baseline(id, connectionId);
    const plan = planPull(store.schema(id), cached.schema, { dialect: cached.dialect, baseline: baseline?.schema });
    return { connected: true, connection: cached.name, database: cached.database, checkedAt: new Date(cached.at).toISOString(), baselineAt: baseline?.at ?? null, ...summarizePlan(plan) };
  });

  /** DB → ERD. apply=false면 미리보기만. 기본으로 DB에서 바뀐 것만 반영하고, ERD에서만 바뀐 설계는 되돌리지 않는다 */
  app.post<{
    Params: { id: string };
    Body: { connectionId: string; apply?: boolean; includeRemovals?: boolean; acceptRenames?: boolean | string[]; selected?: string[]; mode?: Mode; source?: Source };
  }>('/api/projects/:id/db/pull', async (req) => {
    const { id } = req.params;
    const { connectionId, apply = false, includeRemovals = false, source = 'api' } = req.body ?? ({} as never);
    const { saved, config, dialect, db } = await readDb(id, connectionId, req.user.id);
    const current = store.schema(id);
    const baseline = store.baseline(id, connectionId)?.schema;
    const first = planPull(current, db.schema, { dialect, baseline });
    const plan = planPull(current, db.schema, { dialect, baseline, links: acceptedLinks(first, req.body.acceptRenames) });
    const selected = new Set(
      req.body.selected ?? plan.diff.changes.filter((c) => plan.defaultSelected.has(c.id) || (includeRemovals && c.category === 'drop')).map((c) => c.id),
    );
    if (!apply) return { serverVersion: db.serverVersion, ...describePlan(plan), warnings: db.warnings };

    const next = applyChanges(current, plan.diff, selected);
    if (current.tables.length === 0) {
      const positions = await autoLayout(next);
      for (const t of next.tables) t.position = positions.get(t.id) ?? t.position;
    } else {
      placeNewTables(next, plan.diff.changes.flatMap((c) => (c.kind === 'createTable' && selected.has(c.id) ? [c.table.id] : [])));
    }
    store.setMeta(id, { dialect: config.dialect });
    const result = change(id, next, { mode: modeOf(id, req.body.mode, source), source, title: 'DB에서 가져오기', messages: [`${db.serverVersion}에서 ${selected.size}건 반영`], origin: 'db' });
    if (result.mode === 'apply') {
      store.saveVersion(id, `DB 가져오기 · ${saved.name}`, 'db');
      store.setBaseline(id, connectionId, syncedBaseline(db.schema, store.schema(id), { previous: store.baseline(id, connectionId)?.schema }));
    }
    return { ...result, warnings: db.warnings };
  });

  /** ERD → DB. execute=false면 실행할 SQL 미리보기. 기본으로 ERD에서 바뀐 것만 실행하고, DB에서만 바뀐 것은 되돌리지 않는다 */
  app.post<{
    Params: { id: string };
    Body: { connectionId: string; execute?: boolean; includeDrop?: boolean; acceptRenames?: boolean | string[]; selected?: string[]; confirmDatabase?: string; source?: Source };
  }>('/api/projects/:id/db/push', async (req) => {
    const { id } = req.params;
    const { connectionId, execute = false, includeDrop = false, confirmDatabase, source = 'api' } = req.body ?? ({} as never);
    const { saved, config, dialect, db } = await readDb(id, connectionId, req.user.id);
    const schema = store.schema(id);
    const baseline = store.baseline(id, connectionId)?.schema;
    const first = planPush(schema, db.schema, { dialect, baseline });
    const plan = planPush(schema, db.schema, { dialect, baseline, links: acceptedLinks(first, req.body.acceptRenames) });
    const selected = new Set(
      req.body.selected ?? plan.diff.changes.filter((c) => plan.defaultSelected.has(c.id) || (includeDrop && c.category === 'drop')).map((c) => c.id),
    );
    const statements = generateStatements(plan.diff, dialect, selected);
    const preview = { serverVersion: db.serverVersion, database: saved.database, ...describePlan(plan), statements, script: toScript(statements) };
    if (!execute) return preview;
    if (source === 'ai' && !store.meta(id).aiAllowDbExecute) {
      throw Object.assign(new Error('이 프로젝트는 AI가 DB에 실행하는 것을 허용하지 않습니다. 화면의 AI 설정에서 허용하거나, 사람이 "DB로 내보내기"로 실행하세요.'), { statusCode: 403 });
    }
    if (confirmDatabase !== saved.database) throw badRequest(`확인을 위해 confirmDatabase에 데이터베이스 이름("${saved.database}")을 넣어야 합니다`);
    if (!statements.length) return { ...preview, result: { results: [], ok: true, rolledBack: false, appliedCount: 0 } };
    store.saveVersion(id, `DB 적용 전 · ${saved.name}`, 'auto');
    const result = await getConnector(config.dialect).execute(config, statements.map((s) => s.sql));
    executeLog({ at: new Date().toISOString(), project: id, connection: saved.name, database: saved.database, source, ok: result.ok, results: result.results });
    if (result.ok) store.saveVersion(id, `DB 적용 · ${saved.name}`, 'db');
    // 일부만 성공했어도 DB는 바뀌었으므로 지금 DB 상태를 기준 시점으로 다시 잡는다
    if (result.appliedCount > 0) await markSynced(id, connectionId, req.user.id, appliedChanges(plan.diff.changes, statements, result.results));
    return { ...preview, result };
  });
}
