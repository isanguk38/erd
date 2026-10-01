// 프로젝트 REST API. 화면의 일부 기능과 MCP(AI)가 이 API를 쓴다.

import type { FastifyInstance } from 'fastify';
import {
  alignDb,
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
  toLink,
  toScript,
  type ChangeCategory,
  type Command,
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
import type { Auth } from '../auth';

const DIALECTS: DialectId[] = ['mysql', 'postgresql'];
/** 이 시간 동안 AI 변경이 없으면 다음 변경은 새 AI 작업으로 본다 (되돌리기 기준 버전을 새로 만든다) */
const AI_SESSION_IDLE_MS = 30 * 60 * 1000;

type Mode = 'apply' | 'propose';
type Source = 'user' | 'ai' | 'api';

const badRequest = (message: string) => Object.assign(new Error(message), { statusCode: 400 });

function summarize(changes: { id: string; category: ChangeCategory; tableName: string; summary: string; warning?: string }[]) {
  return changes.map(({ id, category, tableName, summary, warning }) => ({ id, category, tableName, summary, warning }));
}

export function registerProjectRoutes(app: FastifyInstance, store: ProjectStore, connections: ConnectionStore, executeLog: (entry: object) => void, auth: Auth) {
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
    store.setSchema(id, next, options.origin ?? (options.source === 'ai' ? 'ai' : 'api'));
    return { mode: 'apply' as const, messages: options.messages, changes: summarize(changes) };
  }

  const modeOf = (id: string, mode: unknown, source: Source): Mode => {
    if (mode === 'apply' || mode === 'propose') return mode;
    return source === 'ai' ? (store.meta(id).aiMode ?? 'apply') : 'apply';
  };

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
      if (b.dbConnectionId) connections.get(b.dbConnectionId, req.user.id);
      patch.dbConnectionId = b.dbConnectionId;
    }
    return store.setMeta(req.params.id, patch);
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
      const mode = modeOf(id, req.body.mode, source);
      // 제안 모드에서는 지금까지 모은 제안 위에 이어서 적용한다
      const base = mode === 'propose' ? (store.proposals(id).find((p) => p.status === 'pending' && p.source === (source === 'ai' ? 'ai' : 'api'))?.target ?? store.schema(id)) : store.schema(id);
      let result;
      try {
        result = applyCommands(base, commands);
      } catch (e) {
        if (e instanceof CommandError) throw badRequest(e.message);
        throw e;
      }
      if (mode === 'propose') {
        const proposal = store.upsertProposal(id, source === 'ai' ? 'ai' : 'api', title, () => ({ schema: result.schema, messages: result.messages }));
        return { mode, proposalId: proposal.id, messages: result.messages, pendingChanges: summarize(store.proposalChanges(id, proposal)) };
      }
      return change(id, result.schema, { mode, source, title, messages: result.messages });
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
  app.post<{ Params: { id: string } }>('/api/projects/:id/ai/undo', async (req) => {
    const { id } = req.params;
    const session = store.meta(id).aiSession;
    if (!session) throw badRequest('되돌릴 AI 작업이 없습니다');
    const version = store.version(id, session.versionId);
    store.saveVersion(id, `AI 변경 되돌리기 전`, 'auto');
    store.setSchema(id, version.schema, 'restore');
    store.setMeta(id, { aiSession: null });
    return { ok: true, restoredVersion: version.name };
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
    const applied = store.applyProposal(req.params.id, req.params.pid, req.body?.selected);
    return { ok: true, applied: summarize(applied) };
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

  app.post<{ Params: { id: string } }>('/api/projects/:id/layout', async (req) => {
    const { id } = req.params;
    const schema = store.schema(id);
    const positions = await autoLayout(schema);
    for (const t of schema.tables) t.position = positions.get(t.id) ?? t.position;
    store.setSchema(id, schema, 'api');
    return { ok: true };
  });

  app.get<{ Params: { id: string }; Querystring: { layout?: 'sheetPerTable' | 'singleSheet'; author?: string; since?: string } }>(
    '/api/projects/:id/definition.xlsx',
    async (req, reply) => {
      const { id } = req.params;
      const meta = store.meta(id);
      const schema = store.schema(id);
      const since = req.query.since ? store.version(id, req.query.since) : undefined;
      const buffer = await buildDefinitionXlsx(schema, {
        projectName: meta.name,
        dialect: meta.dialect as DialectId,
        author: req.query.author,
        layout: req.query.layout,
        changes: since ? { title: `변경 이력 ("${since.name}" 이후)`, items: diffSchemas(since.schema, schema, getDialect(meta.dialect as DialectId)).changes } : undefined,
      });
      reply
        .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${meta.name}_테이블정의서.xlsx`)}`);
      return reply.send(Buffer.from(buffer));
    },
  );

  // ── DB 연동 ─────────────────────────────
  // 3방향 비교의 기준 시점(마지막으로 DB와 맞춘 상태)을 프로젝트·연결별로 저장해 두고, 비교할 때 쓴다.

  const STATUS_CACHE_MS = 60_000;
  const statusCache = new Map<string, { at: number; name: string; database: string; dialect: ReturnType<typeof getDialect>; schema: Schema }>();

  async function readDb(id: string, connectionId: string, userId: string) {
    const saved = connections.get(connectionId, userId);
    const config = connections.config(connectionId, userId);
    await auth.assertAllowedDbHost(config.host);
    const db = await getConnector(config.dialect).introspect(config);
    // 이 프로젝트가 어느 DB와 연결돼 있는지 기억한다 (다른 사람·AI·차이 알림이 같은 DB를 본다)
    if (store.meta(id).dbConnectionId !== connectionId) store.setMeta(id, { dbConnectionId: connectionId });
    return { saved, config, dialect: getDialect(config.dialect), db };
  }

  /** 지금 DB 상태를 기준 시점으로 저장한다 (가져오기·내보내기 직후) */
  async function markSynced(id: string, connectionId: string, userId: string) {
    const { db } = await readDb(id, connectionId, userId);
    return store.setBaseline(id, connectionId, alignDb(db.schema, store.schema(id)));
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
    connections.get(connectionId, req.user.id);
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
      store.setBaseline(id, connectionId, alignDb(db.schema, store.schema(id)));
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
    if (result.appliedCount > 0) await markSynced(id, connectionId, req.user.id);
    return { ...preview, result };
  });
}
