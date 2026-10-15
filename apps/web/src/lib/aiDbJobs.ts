// AI(MCP)가 요청한 DB 작업을 이 앱에서 처리한다 (웹 서비스 서버는 사용자 PC·사내망 DB에 접속하지 않으므로).
// DB로 내보내기는 화면의 "DB로 내보내기"와 같은 순서: 비교 → 안전 검사 → (제안 모드면 사람이 승인) → 실행 → 기록 → 기준 시점.

import {
  adoptDbObjectDefinitions,
  appliedChanges,
  pushedObjectKeys,
  dbmsMismatch,
  generateStatements,
  getDialect,
  planPush,
  safetyChecks,
  safetyFindings,
  skippedChanges,
  syncedBaseline,
  type SafetyFinding,
} from '@erd/core';
import { api, projectApi, type Connection, type ConnectionInput, type DbJob } from './api';

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** 연결 찾기 (id 또는 이름) */
async function findConnection(ref: string | undefined, fallbackId?: string | null): Promise<Connection> {
  const list = await api.listConnections();
  const key = (ref ?? '').trim();
  const found = key ? list.find((c) => c.id === key) ?? list.find((c) => c.name.toLowerCase() === key.toLowerCase()) : list.find((c) => c.id === fallbackId);
  if (!found) {
    throw new Error(key ? `DB 연결 "${key}"이(가) 이 앱에 없습니다. 있는 연결: ${list.map((c) => c.name).join(', ') || '(없음)'}` : '이 프로젝트에 연결된 DB가 없습니다. connection으로 연결을 고르거나 create_connection으로 만드세요');
  }
  return found;
}

const publicConnection = (c: Connection) => ({ id: c.id, name: c.name, dialect: c.dialect, host: c.host, port: c.port, database: c.database, schema: c.schema, ssl: c.ssl });

/** 사람이 승인해야 하는 내보내기 (제안 모드) */
export interface PushApproval {
  projectName: string;
  connection: Connection;
  statements: { sql: string; category: string; warning?: string }[];
}

export interface JobHooks {
  /** 제안 모드: 사람에게 묻고 승인하면 true */
  approve: (request: PushApproval) => Promise<boolean>;
  /** 바로 적용 모드에서 AI가 DB에 실행했을 때 화면에 알린다 */
  notify: (text: string) => void;
  /** 승인을 기다리기 시작할 때 (AI 쪽에 알린다) */
  waiting: () => Promise<void>;
}

/** 작업 하나를 처리하고 결과를 돌려준다 (실패도 결과로 돌려 AI가 원인을 보게 한다) */
export async function runDbJob(job: DbJob, hooks: JobHooks): Promise<Record<string, unknown>> {
  const p = job.payload;
  switch (job.kind) {
    case 'listConnections':
      return { connections: (await api.listConnections()).map(publicConnection) };

    case 'testConnection': {
      const c = await findConnection(p.ref as string);
      try {
        const { serverVersion } = await api.testConnection({ ...c, id: c.id });
        return { ok: true, connection: c.name, serverVersion };
      } catch (e) {
        return { ok: false, connection: c.name, error: message(e) };
      }
    }

    case 'saveConnection': {
      const input = (p.input ?? {}) as Partial<ConnectionInput>;
      const password = typeof p.password === 'string' && p.password ? p.password : undefined;
      if (p.ref) {
        // 고치기: 바꾼 값으로 먼저 접속해 보고, 되면 저장 (비밀번호를 안 주면 저장된 것)
        const c = await findConnection(p.ref as string);
        const { id: _id, hasPassword: _hp, ...current } = c;
        const next: ConnectionInput = { ...current, ...input, ...(password ? { password } : {}) };
        try {
          const { serverVersion } = await api.testConnection({ ...next, id: c.id });
          const saved = await api.updateConnection(c.id, next);
          return { ok: true, connection: publicConnection(saved), serverVersion };
        } catch (e) {
          return { ok: false, stage: 'test', connection: c.name, error: message(e) };
        }
      }
      const next = { ...input, ...(password ? { password } : {}) } as ConnectionInput;
      let serverVersion: string;
      try {
        serverVersion = (await api.testConnection(next)).serverVersion;
      } catch (e) {
        return { ok: false, stage: 'test', error: message(e) };
      }
      const saved = await api.createConnection(next);
      if (p.projectId) await projectApi.setDbConnection(p.projectId as string, saved.id);
      return { ok: true, connection: publicConnection(saved), serverVersion };
    }

    case 'push':
      return pushJob(job, hooks);

    case 'pull':
      return pullJob(job);
  }
}

/** DB에서 가져오기: 이 PC의 앱이 로컬에서 DB를 읽고, 반영은 서버가 화면의 가져오기와 같은 규칙으로 한다 */
async function pullJob(job: DbJob): Promise<Record<string, unknown>> {
  const p = job.payload;
  const projectId = job.projectId!;
  const { meta } = await projectApi.get(projectId);
  const connection = await findConnection(p.ref as string | undefined, meta.dbConnectionId);
  const mismatch = dbmsMismatch(meta.dialect, connection.dialect);
  if (mismatch) throw new Error(mismatch);
  let db;
  try {
    db = await api.introspect(connection.id);
  } catch (e) {
    void projectApi.recordDbLog(projectId, connection, { action: 'pull', stage: 'compare', ok: false, error: message(e) });
    return { ok: false, connection: connection.name, error: message(e) };
  }
  const result = await projectApi.pullLocal(projectId, {
    connectionId: connection.id,
    connectionName: `${connection.name} (${connection.database})`,
    db,
    apply: Boolean(p.apply),
    includeRemovals: Boolean(p.includeRemovals),
    // 따로 정하지 않으면 프로젝트의 AI 모드를 따른다 (바로 적용 프로젝트가 제안으로 바뀌지 않게)
    mode: p.mode === 'apply' || p.mode === 'propose' ? p.mode : undefined,
    source: 'ai',
  });
  return { ok: true, connection: connection.name, database: connection.database, ...result, ...(Array.isArray(db.schema.objects) ? {} : { note: '이 설치형 앱 버전은 뷰·함수 등 DB 객체를 읽지 못해 테이블만 가져왔습니다 (앱을 업데이트하면 객체도)' }) };
}

async function pushJob(job: DbJob, hooks: JobHooks): Promise<Record<string, unknown>> {
  const p = job.payload;
  const projectId = job.projectId!;
  const { meta, schema } = await projectApi.get(projectId);
  const connection = await findConnection(p.ref as string | undefined, meta.dbConnectionId);
  const mismatch = dbmsMismatch(meta.dialect, connection.dialect);
  if (mismatch) throw new Error(mismatch);
  const dialect = getDialect(meta.dialect);
  const log = (entry: Parameters<typeof projectApi.recordDbLog>[2]) => void projectApi.recordDbLog(projectId, connection, entry);

  // ① 비교
  let db, baseline;
  try {
    [db, baseline] = await Promise.all([api.introspect(connection.id), projectApi.baseline(projectId, connection.id)]);
  } catch (e) {
    log({ action: 'push', stage: 'compare', ok: false, error: message(e) });
    return { ok: false, executed: false, connection: connection.name, error: message(e) };
  }
  const plan = planPush(schema, db.schema, { dialect, baseline: baseline?.schema });
  const selected = new Set(plan.defaultSelected);
  if (p.includeDrop) for (const c of plan.diff.changes) if (c.category === 'drop') selected.add(c.id);
  const statements = generateStatements(plan.diff, dialect, selected);
  const remainingDrops = plan.diff.changes.filter((c) => c.category === 'drop' && !selected.has(c.id)).map((c) => c.summary);
  const base = { connection: connection.name, database: connection.database, serverVersion: db.serverVersion, ...(remainingDrops.length ? { notIncludedDrops: remainingDrops } : {}) };
  if (!statements.length) return { ...base, ok: true, executed: false, message: '실행할 것이 없습니다 (ERD에서 바뀐 것이 DB에 이미 있음)' };

  // ② 안전 검사 (지금 데이터로 실패하거나 데이터가 사라지는 변경)
  const changes = plan.diff.changes.filter((c) => selected.has(c.id));
  const checks = safetyChecks(changes, plan.dbAligned);
  let findings: { summary: string; items: SafetyFinding[] }[] = [];
  if (checks.length) {
    const results = await api.check(connection.id, checks).catch(() => null);
    if (results) {
      const found = safetyFindings(checks, results);
      findings = changes.filter((c) => found.has(c.id)).map((c) => ({ summary: c.summary, items: found.get(c.id)! }));
    }
  }
  const sql = statements.map((s) => s.sql);
  if (findings.some((f) => f.items.some((i) => i.level === 'fail'))) {
    return { ...base, ok: false, executed: false, blocked: 'safety', message: '지금 데이터로는 실패할 변경이 있어 실행하지 않았습니다 (데이터를 정리하거나 ERD를 고친 뒤 다시)', findings, statements: sql };
  }
  if (p.dryRun) return { ...base, ok: true, executed: false, dryRun: true, statements: sql, findings };

  // ③ 제안 모드: 사람이 승인해야 실행
  if (p.mode !== 'apply') {
    await hooks.waiting();
    const ok = await hooks.approve({ projectName: meta.name, connection, statements: statements.map((s) => ({ sql: s.sql, category: s.category, warning: s.warning })) });
    if (!ok) return { ...base, ok: false, executed: false, rejected: true, message: '사용자가 실행을 거절했습니다', statements: sql };
  }

  // ④ 실행 (화면의 DB로 내보내기와 같게: 실행 전후 버전, 기록, 기준 시점)
  const label = `${connection.name} (${connection.database}) · AI`;
  await projectApi.saveVersion(projectId, `DB 적용 전 · ${label}`, 'auto', schema).catch(() => {});
  let r;
  try {
    r = await api.execute(connection.id, sql);
  } catch (e) {
    log({ action: 'push', stage: 'execute', ok: false, serverVersion: db.serverVersion, error: message(e), results: sql.map((s) => ({ sql: s, ok: false, skipped: true })) });
    return { ...base, ok: false, executed: false, error: message(e) };
  }
  log({ action: 'push', stage: 'execute', ok: r.ok, serverVersion: db.serverVersion, results: r.results, rolledBack: r.rolledBack, appliedCount: r.appliedCount });
  if (r.ok) await projectApi.saveVersion(projectId, `DB 적용 · ${label}`, 'db', schema).catch(() => {});
  if (r.appliedCount > 0) {
    const after = await api.introspect(connection.id);
    const applied = appliedChanges(plan.diff.changes, statements, r.results);
    const skipped = skippedChanges(plan.diff.changes, applied);
    // 내보낸 DB 객체(뷰·함수 등)는 DB가 다시 쓴 모양으로 ERD를 맞춘다 (다음 비교에서 "ERD에서 바뀜"으로 보이지 않게)
    let erd = schema;
    const adopt = adoptDbObjectDefinitions(schema, after.schema, pushedObjectKeys(applied));
    if (adopt.length) {
      const byId = new Map(schema.objects?.map((o) => [o.id, o]));
      await projectApi.commands(projectId, adopt.map((u) => ({ op: 'updateObject', name: byId.get(u.id)!.name, kind: byId.get(u.id)!.kind, definition: u.definition })));
      erd = (await projectApi.get(projectId)).schema;
    }
    await projectApi.saveBaseline(projectId, connection.id, syncedBaseline(after.schema, erd, { applied, previous: baseline?.schema, skipped, dialect, direction: 'push' }));
  }
  if (p.mode === 'apply') hooks.notify(r.ok ? `AI가 ${meta.name}의 변경 ${sql.length}문장을 DB(${connection.name})에 실행했습니다` : `AI가 DB(${connection.name})에 실행하다 실패했습니다 — AI가 원인을 보고 있습니다`);
  return {
    ...base,
    ok: r.ok,
    executed: true,
    rolledBack: r.rolledBack,
    appliedCount: r.appliedCount,
    results: r.results.map(({ sql: s, ok, skipped, error }) => ({ sql: s, ok, ...(skipped ? { skipped } : {}), ...(error ? { error } : {}) })),
    findings,
  };
}
