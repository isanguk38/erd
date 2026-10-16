// 프로젝트 REST API. 화면의 일부 기능과 MCP(AI)가 이 API를 쓴다.

import type { FastifyInstance } from 'fastify';
import {
  adoptDbObjectDefinitions,
  pushedObjectKeys,
  erdTermNotes,
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
  namingNotes,
  projectNamingStyles,
  stylesOf,
  describeNaming,
  syncDictionaryForAi,
  addMissingTerms,
  readDictionary,
  dictIndex,
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
  dbmsMismatch,
  ddlGrammarOf,
  skippedChanges,
} from '@erd/core';
import { autoLayout } from '@erd/core/layout';
import { buildDefinitionXlsx } from '@erd/core/excel';
import { getConnector } from '@erd/db';
import type { ConnectionStore } from '../connections';
import type { Origin, ProjectStore } from '../projects';
import { DESKTOP_ONLY_MESSAGE, type Auth } from '../auth';
import { cleanDbLog, scrubSecret } from '../dbLog';

const DIALECTS = Object.keys(dialects) as DialectId[];
/** 이 시간 동안 AI 변경이 없으면 다음 변경은 새 AI 작업으로 본다 (되돌리기 기준 버전을 새로 만든다) */
const AI_SESSION_IDLE_MS = 30 * 60 * 1000;

type Mode = 'apply' | 'propose';
const AREA_OPS = new Set(['createArea', 'updateArea', 'dropArea', 'addToArea', 'removeFromArea', 'moveToArea']);
/** 화면에서만 보이는 명령 (영역, 테이블 색만 바꾸기): 설계·DB가 바뀌지 않아 제안 모드에서도 바로 반영한다 */
const visualOnly = (c: Command) =>
  AREA_OPS.has(c?.op) || (c?.op === 'updateTable' && Object.keys(c).every((k) => k === 'op' || k === 'table' || k === 'color'));
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
      const fresh = !session || now.getTime() - new Date(session.lastAt).getTime() > AI_SESSION_IDLE_MS;
      if (fresh) {
        const version = store.saveVersion(id, `AI 작업 전 · ${now.toLocaleString('ko-KR')}`, 'auto', before);
        store.setMeta(id, { aiSession: { versionId: version.id, startedAt: now.toISOString(), lastAt: now.toISOString(), changeCount: changes.length } });
      } else {
        store.setMeta(id, { aiSession: { ...session, lastAt: now.toISOString(), changeCount: session.changeCount + changes.length } });
      }
      // 바로 적용해도 무엇이 바뀌었는지는 화면에서 볼 수 있게 남긴다
      store.addAiLog(id, { at: now.toISOString(), messages: options.messages, changes: summarize(changes) }, fresh);
    }
    if (options.source === 'ai' && changes.length) store.pushAiStep(id, before, next);
    store.setSchema(id, next, options.origin ?? (options.source === 'ai' ? 'ai' : 'api'));
    return { mode: 'apply' as const, messages: options.messages, changes: summarize(changes) };
  }

  /** 함께 바뀐 것(영향도)과, 이번에 만들거나 바꾼 이름 중 프로젝트 표기 기준과 다른 것 */
  function reviewNotes(id: string, before: Schema, after: Schema) {
    const impact = changeImpact(before, after);
    const dict = readDictionary(store.load(id).doc);
    const styles = stylesOf(projectNamingStyles(store.meta(id).namingStyle, after, dict ? dictIndex(dict).styles : null));
    const naming = namingNotes(before, after, styles);
    const dictionary = syncDictionaryForAi(dict, before, after).notes;
    // 사전이 없어도: 지금 ERD로 사전 화면의 "ERD에서 만들기"를 했을 때 나올 문제 (사전 화면과 같은 규칙 checkDictDraft)
    const terms = erdTermNotes(before, after, { dictionary: dict, saved: store.meta(id).namingStyle }).map((n) => n.message);
    return { ...(impact.length ? { impact } : {}), ...(naming.length ? { naming } : {}), ...(dictionary.length ? { dictionary } : {}), ...(terms.length ? { terms } : {}) };
  }

  /**
   * AI가 만든 컬럼·테이블 중 사전에 없는 용어를 사전에 넣는다 (사전이 있을 때만).
   * 같은 논리명·물리명이 이미 있으면 넣지 않고, 표기 기준과 다른 이름은 넣지 않는다. 넣은 용어 "논리명=물리명"
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

  /**
   * 표기 기준을 아직 정하지 않은 쪽(테이블·컬럼 따로)은, AI가 반영한 뒤의 이름들로 판단해 저장한다
   * (처음 AI가 테이블 camelCase·컬럼 snake_case로 만들면 다음 명령부터 그 기준을 따른다).
   * 용어 사전에 그 종류의 용어가 있으면 사전 표기가 이미 기준이라 저장하지 않는다. 새로 저장했으면 저장한 기준
   */
  function rememberNamingStyle(id: string): string | undefined {
    const dict = readDictionary(store.load(id).doc);
    const r = projectNamingStyles(store.meta(id).namingStyle, store.schema(id), dict ? dictIndex(dict).styles : null);
    const pick = (k: 'table' | 'column') => (r[k].from === 'names' ? r[k].style : null);
    if (!pick('table') && !pick('column')) return undefined;
    const saved = store.meta(id).namingStyle;
    const next = { table: saved?.table ?? pick('table'), column: saved?.column ?? pick('column') };
    store.setMeta(id, { namingStyle: next }, 'ai');
    return describeNaming(next);
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
    // DB 종류는 프로젝트를 만들 때 정하고 바꾸지 않는다
    if (b.dialect !== undefined && b.dialect !== store.dialect(req.params.id)) throw badRequest(dbmsMismatch(store.dialect(req.params.id), String(b.dialect), 'DB 종류로 바꾸는 것')!);
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
      // 영역·테이블 색 명령만 있으면 제안 없이 바로 반영한다 (화면에서 보는 구분일 뿐 설계·DB는 바뀌지 않음).
      // 아직 제안에만 있는 테이블을 가리키면 제안에 이어서 넣는다
      if (mode === 'propose' && commands.every(visualOnly)) {
        try {
          const direct = applyCommands(store.schema(id), commands, getDialect(store.dialect(id)));
          return change(id, direct.schema, { mode: 'apply', source, title, messages: [...direct.messages, '영역·테이블 색은 화면에서 보는 구분이라 제안 없이 바로 반영했습니다'] });
        } catch (e) {
          if (!(e instanceof CommandError)) throw e;
        }
      }
      // 제안 모드에서는 지금까지 모은 제안 위에 이어서 적용한다
      const base = mode === 'propose' ? (store.proposals(id).find((p) => p.status === 'pending' && p.source === (source === 'ai' ? 'ai' : 'api'))?.target ?? store.schema(id)) : store.schema(id);
      let result;
      try {
        result = applyCommands(base, commands, getDialect(store.dialect(id)));
      } catch (e) {
        if (e instanceof CommandError) throw badRequest(e.message);
        throw e;
      }
      // 함께 바뀐 것(영향도)과 표준 용어 사전과 다른 컬럼을 알려 준다 (AI가 바로 이어서 고치게)
      const extra = reviewNotes(id, base, result.schema);
      // 바뀐 것이 없으면 빈 제안을 만들지 않는다
      if (JSON.stringify(result.schema) === JSON.stringify(base)) return { mode, messages: [...result.messages, '바뀐 것이 없어 반영하지 않았습니다'], unchanged: true };
      if (mode === 'propose') {
        const proposal = store.upsertProposal(id, source === 'ai' ? 'ai' : 'api', title, () => ({ schema: result.schema, messages: result.messages }));
        // 사전에 없는 용어는 사람이 제안을 승인할 때 사전에 넣는다
        return { mode, proposalId: proposal.id, messages: result.messages, pendingChanges: summarize(store.proposalChanges(id, proposal)), ...extra };
      }
      const applied = change(id, result.schema, { mode, source, title, messages: result.messages });
      const dictionaryAdded = source === 'ai' ? addAiTerms(id, base, result.schema) : [];
      const namingStyleSaved = source === 'ai' ? rememberNamingStyle(id) : undefined;
      return { ...applied, ...extra, ...(dictionaryAdded.length ? { dictionaryAdded } : {}), ...(namingStyleSaved ? { namingStyleSaved } : {}) };
    },
  );

  app.post<{ Params: { id: string }; Body: { sql: string; mode?: Mode; source?: Source; dialect?: DialectId | 'auto' } }>(
    '/api/projects/:id/import-ddl',
    async (req) => {
      const { id } = req.params;
      const { sql, source = 'api' } = req.body ?? ({} as never);
      if (!sql?.trim()) throw badRequest('sql이 필요합니다');
      const current = store.schema(id);
      // 프로젝트 DB 종류의 문법으로만 읽는다 (다른 DB의 DDL을 바꿔 넣지 않는다)
      const project = getDialect(store.dialect(id));
      if (!project.ddlGrammar) throw badRequest(`${project.label} 프로젝트는 SQL 붙여넣기(DDL 가져오기)를 지원하지 않습니다. DB에서 가져오기를 쓰세요`);
      const found = ddlGrammarOf(sql);
      if (found && found !== project.ddlGrammar.family) throw badRequest(dbmsMismatch(project.id, found, 'DDL')!);
      if (req.body.dialect && req.body.dialect !== 'auto' && req.body.dialect !== project.id) throw badRequest(dbmsMismatch(project.id, req.body.dialect, 'DDL')!);
      const parsed = parseDdl(sql, { dialect: project.id, context: current });
      const diff = diffIncoming(current, parsed.schema, project);
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
      store.clearAiLog(id);
      return { ok: true, restoredVersion: version.name };
    }
    const step = store.popAiStep(id);
    if (!step) throw badRequest('되돌릴 AI 작업이 없습니다');
    const dialect = getDialect(store.dialect(id));
    const reverse = diffSchemas(step.after, step.before, dialect);
    store.saveVersion(id, `AI 변경 되돌리기 전`, 'auto');
    store.setSchema(id, applyChanges(store.schema(id), reverse), 'restore');
    store.popAiLog(id);
    const session = store.meta(id).aiSession;
    if (session) {
      const left = Math.max(0, session.changeCount - reverse.changes.length);
      store.setMeta(id, { aiSession: left ? { ...session, changeCount: left } : null });
    }
    return { ok: true, undone: summarize(reverse.changes), at: step.at };
  });

  // 바로 적용한 AI 작업의 이력 (최근 것부터). "유지"를 눌러도 다음 AI 작업 묶음이 시작될 때까지 볼 수 있다
  app.get<{ Params: { id: string } }>('/api/projects/:id/ai/log', async (req) => store.aiLog(req.params.id).reverse());

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

  // ── DB 작업 기록 (가져오기·내보내기 오류를 AI가 분석할 수 있게) ─────────────────────────────
  // 웹 서비스에서는 설치형 앱이 DB에 접속하므로, 화면이 결과를 여기에 남긴다
  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/projects/:id/db/log', async (req) => {
    try {
      return { id: store.addDbLog(req.params.id, cleanDbLog(req.body ?? {}, req.user.name, 'screen')).id };
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode) throw e;
      throw badRequest(e instanceof Error ? e.message : String(e));
    }
  });
  /** failed=1이면 실패한 것만, limit(기본 10) */
  app.get<{ Params: { id: string }; Querystring: { failed?: string; limit?: string } }>('/api/projects/:id/db/log', async (req) => {
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));
    const failed = req.query.failed === '1' || req.query.failed === 'true';
    return store.dbLog(req.params.id).filter((e) => !failed || !e.ok || e.results?.some((r) => !r.ok && !r.skipped)).slice(0, limit);
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
    const proposal = store.proposals(id).find((p) => p.id === pid);
    const fromAi = proposal?.source === 'ai';
    const total = proposal && proposal.status === 'pending' ? store.proposalChanges(id, proposal).length : 0;
    const applied = store.applyProposal(id, pid, req.body?.selected);
    // AI가 DB에서 가져온 제안을 모두 승인하면: 그 DB 구조로 기준 시점을 저장한다 (일부만 승인하면 저장하지 않음 — 안 넣은 것이 "ERD에서 바뀜"으로 보이지 않게)
    const pending = store.takePendingPull(id, pid);
    if (pending && applied.length === total) {
      const dialect = getDialect(store.dialect(id));
      store.saveVersion(id, `DB 가져오기 · ${pending.connectionName}`, 'db');
      store.setBaseline(id, pending.connectionId, syncedBaseline(pending.db, store.schema(id), { previous: store.baseline(id, pending.connectionId)?.schema, dialect, direction: 'pull' }));
      if (store.meta(id).dbConnectionId !== pending.connectionId) store.setMeta(id, { dbConnectionId: pending.connectionId });
    }
    // AI 제안을 승인하면 승인한 것 중 사전에 없는 용어를 사전에 넣고, 아직 표기 기준이 없으면 그 이름들로 기준을 정한다
    const dictionaryAdded = fromAi ? addAiTerms(id, before, store.schema(id)) : [];
    if (fromAi) rememberNamingStyle(id);
    return { ok: true, applied: summarize(applied), ...(dictionaryAdded.length ? { dictionaryAdded } : {}) };
  });
  app.post<{ Params: { id: string; pid: string } }>('/api/projects/:id/proposals/:pid/reject', async (req) => {
    store.rejectProposal(req.params.id, req.params.pid);
    return { ok: true };
  });

  // ── SQL / 배치 / 정의서 ─────────────────────────────
  app.get<{ Params: { id: string }; Querystring: { dialect?: DialectId; since?: string } }>('/api/projects/:id/sql', async (req) => {
    const { id } = req.params;
    // SQL은 프로젝트 DB 종류로만 만든다 (다른 DB로 변환하지 않는다)
    if (req.query.dialect && req.query.dialect !== store.dialect(id)) throw badRequest(dbmsMismatch(store.dialect(id), req.query.dialect, 'SQL')!);
    const dialect = getDialect(store.dialect(id));
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

  /** log: 가져오기·내보내기에서 DB를 읽다 실패하면 DB 작업 기록에 남긴다 (AI가 원인을 볼 수 있게) */
  async function readDb(id: string, connectionId: string, userId: string, log?: { action: 'pull' | 'push'; by?: string }) {
    if (!serverDb) throw desktopOnly();
    const saved = connections.get(connectionId, userId);
    const config = connections.config(connectionId, userId);
    // 프로젝트와 다른 DB 종류의 연결은 쓸 수 없다
    const mismatch = dbmsMismatch(store.dialect(id), config.dialect);
    if (mismatch) throw badRequest(mismatch);
    await auth.assertAllowedDbHost(config.host);
    let db;
    try {
      db = await getConnector(config.dialect).introspect(config);
    } catch (e) {
      if (log) {
        const error = scrubSecret(e instanceof Error ? e.message : String(e));
        store.addDbLog(id, { by: log.by, action: log.action, stage: 'compare', via: 'server', ok: false, connection: { name: saved.name, dialect: config.dialect, database: saved.database }, error });
      }
      throw e;
    }
    // 이 프로젝트가 어느 DB와 연결돼 있는지 기억한다 (다른 사람·AI·차이 알림이 같은 DB를 본다)
    if (store.meta(id).dbConnectionId !== connectionId) store.setMeta(id, { dbConnectionId: connectionId });
    return { saved, config, dialect: getDialect(config.dialect), db };
  }

  /** 지금 DB 상태를 기준 시점으로 저장한다 (가져오기·내보내기 직후) */
  async function markSynced(id: string, connectionId: string, userId: string, applied: Change[] = [], skipped: Change[] = []) {
    const { db, dialect } = await readDb(id, connectionId, userId);
    const previous = store.baseline(id, connectionId)?.schema;
    // 내보낸 DB 객체(뷰·함수 등)는 DB가 다시 쓴 모양으로 ERD를 맞춘다 (다음 비교에서 "ERD에서 바뀜"으로 보이지 않게)
    const adopt = adoptDbObjectDefinitions(store.schema(id), db.schema, pushedObjectKeys(applied));
    if (adopt.length) {
      const next = store.schema(id);
      for (const u of adopt) {
        const o = next.objects?.find((x) => x.id === u.id);
        if (o) o.definition = u.definition;
      }
      store.setSchema(id, next, 'db');
    }
    return store.setBaseline(id, connectionId, syncedBaseline(db.schema, store.schema(id), { applied, previous, skipped, dialect, direction: 'push' }));
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

  type PullBody = { connectionId: string; apply?: boolean; includeRemovals?: boolean; acceptRenames?: boolean | string[]; selected?: string[]; mode?: Mode; source?: Source };

  /**
   * DB 구조(db)를 ERD에 반영한다. apply=false면 미리보기만. 기본으로 DB에서 바뀐 것만 반영하고, ERD에서만 바뀐 설계는 되돌리지 않는다.
   * 반영 결과에 영역에 아직 없는 테이블(unassignedTables)을 알려 준다 (AI가 이어서 주제영역으로 묶게)
   */
  async function pullInto(id: string, connectionName: string, db: { schema: Schema; serverVersion: string; warnings: string[] }, body: PullBody) {
    const { connectionId, apply = false, includeRemovals = false, source = 'api' } = body;
    const dialect = getDialect(store.dialect(id));
    const current = store.schema(id);
    const baseline = store.baseline(id, connectionId)?.schema;
    const first = planPull(current, db.schema, { dialect, baseline });
    const plan = planPull(current, db.schema, { dialect, baseline, links: acceptedLinks(first, body.acceptRenames) });
    const selected = new Set(body.selected ?? plan.diff.changes.filter((c) => plan.defaultSelected.has(c.id) || (includeRemovals && c.category === 'drop')).map((c) => c.id));
    if (!apply) return { serverVersion: db.serverVersion, ...describePlan(plan), warnings: db.warnings };

    const next = applyChanges(current, plan.diff, selected);
    if (current.tables.length === 0) {
      const positions = await autoLayout(next);
      for (const t of next.tables) t.position = positions.get(t.id) ?? t.position;
    } else {
      placeNewTables(next, plan.diff.changes.flatMap((c) => (c.kind === 'createTable' && selected.has(c.id) ? [c.table.id] : [])));
    }
    const result = change(id, next, { mode: modeOf(id, body.mode, source), source, title: 'DB에서 가져오기', messages: [`DB에서 가져오기 · ${connectionName} (${db.serverVersion}): DB에서 바뀐 것 ${selected.size}건 반영`], origin: 'db' });
    // 제안으로 쌓이면 DB 구조를 맡아 두었다가, 모두 승인될 때 기준 시점으로 저장한다 (proposals/:pid/apply)
    if (result.mode === 'propose') store.setPendingPull(id, result.proposalId, { connectionId, connectionName, db: db.schema });
    if (result.mode === 'apply') {
      store.saveVersion(id, `DB 가져오기 · ${connectionName}`, 'db');
      // 반영하지 않은 변경은 기준 시점에 넣지 않는다 (다음에도 "DB에서 바뀜"으로)
      store.setBaseline(id, connectionId, syncedBaseline(db.schema, store.schema(id), { previous: store.baseline(id, connectionId)?.schema, skipped: skippedChanges(plan.diff.changes, selected), dialect, direction: 'pull' }));
      if (store.meta(id).dbConnectionId !== connectionId) store.setMeta(id, { dbConnectionId: connectionId });
    }
    const after = store.schema(id);
    const inArea = new Set((after.areas ?? []).flatMap((a) => a.tableIds));
    const unassignedTables = after.tables.filter((t) => !inArea.has(t.id)).map((t) => t.name);
    return { ...result, warnings: db.warnings, tableCount: after.tables.length, areas: (after.areas ?? []).map((a) => a.name), unassignedTables };
  }

  /** DB → ERD (서버가 DB에 접속하는 로컬·자체 설치 모드) */
  app.post<{ Params: { id: string }; Body: PullBody }>('/api/projects/:id/db/pull', async (req) => {
    const { id } = req.params;
    const { saved, db } = await readDb(id, req.body?.connectionId, req.user.id, { action: 'pull', by: req.user.name });
    return pullInto(id, saved.name, db, req.body ?? ({} as never));
  });

  /** DB → ERD: 사용자 PC의 앱이 로컬에서 읽은 DB 구조를 받아 반영한다 (웹 서비스는 서버가 DB에 접속하지 않으므로, AI 가져오기도 이 길) */
  app.post<{ Params: { id: string }; Body: PullBody & { connectionName?: string; db?: { schema: Schema; serverVersion?: string; warnings?: string[] } } }>('/api/projects/:id/db/pull-local', async (req) => {
    const { db, connectionName = 'DB' } = req.body ?? ({} as never);
    if (!req.body?.connectionId || !db?.schema || !Array.isArray(db.schema.tables)) throw badRequest('connectionId와 앱이 읽은 DB 구조(db.schema)가 필요합니다');
    return pullInto(req.params.id, connectionName, { schema: db.schema, serverVersion: db.serverVersion ?? '', warnings: db.warnings ?? [] }, req.body);
  });

  /** ERD → DB. execute=false면 실행할 SQL 미리보기. 기본으로 ERD에서 바뀐 것만 실행하고, DB에서만 바뀐 것은 되돌리지 않는다 */
  app.post<{
    Params: { id: string };
    Body: { connectionId: string; execute?: boolean; includeDrop?: boolean; acceptRenames?: boolean | string[]; selected?: string[]; confirmDatabase?: string; source?: Source };
  }>('/api/projects/:id/db/push', async (req) => {
    const { id } = req.params;
    const { connectionId, execute = false, includeDrop = false, confirmDatabase, source = 'api' } = req.body ?? ({} as never);
    const { saved, config, dialect, db } = await readDb(id, connectionId, req.user.id, { action: 'push', by: req.user.name });
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
    store.addDbLog(id, cleanDbLog({ action: 'push', stage: 'execute', ok: result.ok, connection: { name: saved.name, dialect: config.dialect, database: saved.database, serverVersion: db.serverVersion }, results: result.results, rolledBack: result.rolledBack, appliedCount: result.appliedCount }, req.user.name, 'server'));
    if (result.ok) store.saveVersion(id, `DB 적용 · ${saved.name}`, 'db');
    // 일부만 성공했어도 DB는 바뀌었으므로 지금 DB 상태를 기준 시점으로 다시 잡는다
    if (result.appliedCount > 0) {
      const applied = appliedChanges(plan.diff.changes, statements, result.results);
      await markSynced(id, connectionId, req.user.id, applied, skippedChanges(plan.diff.changes, applied));
    }
    return { ...preview, result };
  });
}
