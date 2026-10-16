// AI(MCP)가 요청한 DB 작업을 이 앱에서 처리한다 (웹 서비스 서버는 사용자 PC·사내망 DB에 접속하지 않으므로).
// DB로 내보내기는 화면의 "DB로 내보내기"와 같은 순서: 비교 → 안전 검사 → 사람이 승인 → 실행 → 기록 → 기준 시점.
// DB에 실행하는 것은 되돌리기 어려워, 프로젝트 AI 모드가 바로 적용이어도 항상 사람이 SQL을 보고 승인해야 실행한다.

import {
  adoptDbObjectDefinitions,
  appliedChanges,
  pushedObjectKeys,
  dbmsMismatch,
  generateSeedData,
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

/** 사람이 승인해야 하는 내보내기 (AI 모드와 상관없이 항상) */
export interface PushApproval {
  projectName: string;
  connection: Connection;
  statements: { sql: string; category: string; warning?: string }[];
  /** seed: 테스트 데이터 넣기 (기본은 DB로 내보내기) */
  purpose?: 'push' | 'seed';
  /** 승인 창에 보일 한 줄 요약 (예: "3개 테이블 60행") */
  summary?: string;
}

export interface JobHooks {
  /** 사람에게 묻고 승인하면 true */
  approve: (request: PushApproval) => Promise<boolean>;
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

    case 'compare':
      return compareJob(job);

    case 'seed':
      return seedJob(job, hooks);
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

  // ③ 사람이 승인해야 실행 (바로 적용 모드여도 — DB 실행은 되돌리기 어렵다)
  await hooks.waiting();
  const ok = await hooks.approve({ projectName: meta.name, connection, statements: statements.map((s) => ({ sql: s.sql, category: s.category, warning: s.warning })) });
  if (!ok) return { ...base, ok: false, executed: false, rejected: true, message: '사용자가 실행을 거절했습니다', statements: sql };

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

/** DB끼리 비교: 두 연결을 읽기만 하고, 대상을 기준과 같게 만드는 변경·SQL을 돌려준다 (실행하지 않음) */
async function compareJob(job: DbJob): Promise<Record<string, unknown>> {
  const p = job.payload;
  const source = await findConnection(p.source as string);
  const target = await findConnection(p.target as string);
  if (source.id === target.id) throw new Error('서로 다른 두 연결을 고르세요');
  const mismatch = dbmsMismatch(source.dialect, target.dialect);
  if (mismatch) throw new Error(`두 DB의 종류가 다릅니다: ${mismatch}`);
  const read = async (c: Connection) => {
    try {
      return await api.introspect(c.id);
    } catch (e) {
      throw new Error(`${c.name}: ${message(e)}`);
    }
  };
  let s, t;
  try {
    [s, t] = await Promise.all([read(source), read(target)]);
  } catch (e) {
    return { ok: false, error: message(e) };
  }
  const dialect = getDialect(source.dialect);
  const plan = planPush(s.schema, t.schema, { dialect });
  const selected = new Set(plan.defaultSelected);
  if (p.includeDrop) for (const c of plan.diff.changes) if (c.category === 'drop') selected.add(c.id);
  const statements = generateStatements(plan.diff, dialect, selected);
  const where = (c: Connection, v: string) => ({ name: c.name, database: c.database, host: c.host, serverVersion: v });
  return {
    ok: true,
    source: where(source, s.serverVersion),
    target: where(target, t.serverVersion),
    same: plan.diff.changes.length === 0,
    onlyInSource: plan.diff.changes.filter((c) => c.category === 'create').map((c) => c.summary),
    different: plan.diff.changes.filter((c) => c.category === 'alter').map((c) => ({ summary: c.summary, ...(c.warning ? { warning: c.warning } : {}) })),
    onlyInTarget: plan.diff.changes.filter((c) => c.category === 'drop').map((c) => c.summary),
    renameCandidates: plan.renames.map((r) => `${r.kind === 'table' ? '테이블' : `${r.tableName} 컬럼`} ${r.dbName} → ${r.erdName}?`),
    objectsCompared: Array.isArray(s.schema.objects) && Array.isArray(t.schema.objects),
    // 대상 DB를 기준과 같게 만드는 SQL (실행하지 않음. DROP은 includeDrop일 때만)
    statements: statements.map((x) => x.sql),
  };
}

/** 테스트 데이터 넣기: 프로젝트 ERD로 INSERT를 만들고, 사람이 승인하면 고른 DB에 넣는다 */
async function seedJob(job: DbJob, hooks: JobHooks): Promise<Record<string, unknown>> {
  const p = job.payload;
  const projectId = job.projectId!;
  const { meta, schema } = await projectApi.get(projectId);
  const connection = await findConnection(p.ref as string | undefined, meta.dbConnectionId);
  const mismatch = dbmsMismatch(meta.dialect, connection.dialect);
  if (mismatch) throw new Error(mismatch);
  const dialect = getDialect(meta.dialect);
  const tableIds = Array.isArray(p.tables) && p.tables.length
    ? (p.tables as string[]).map((name) => {
        const t = schema.tables.find((x) => x.name === name) ?? schema.tables.find((x) => x.name.toLowerCase() === String(name).toLowerCase());
        if (!t) throw new Error(`테이블 "${name}"이 없습니다`);
        return t.id;
      })
    : undefined;
  const seed = generateSeedData(schema, dialect, { rows: Number(p.rows) || undefined, startId: p.startId === undefined ? undefined : Number(p.startId), seed: Number(p.seed) || undefined, tableIds });
  const summary = { tables: seed.tables.map((t) => ({ name: t.name, rows: t.rows })), added: seed.added, skipped: seed.skipped, warnings: seed.warnings };
  const base = { connection: connection.name, database: connection.database, ...summary };
  if (!seed.statements.length) return { ...base, ok: false, executed: false, message: '넣을 데이터가 없습니다' };
  const total = seed.tables.reduce((n, t) => n + t.rows, 0);

  await hooks.waiting();
  const ok = await hooks.approve({
    projectName: meta.name,
    connection,
    purpose: 'seed',
    summary: `${seed.tables.length}개 테이블 ${total}행`,
    statements: seed.statements.map((sql) => ({ sql, category: 'create' })),
  });
  if (!ok) return { ...base, ok: false, executed: false, rejected: true, message: '사용자가 테스트 데이터 넣기를 거절했습니다' };

  let r;
  try {
    r = await api.execute(connection.id, seed.statements);
  } catch (e) {
    void projectApi.recordDbLog(projectId, connection, { action: 'seed', stage: 'execute', ok: false, error: message(e) });
    return { ...base, ok: false, executed: false, error: message(e) };
  }
  void projectApi.recordDbLog(projectId, connection, { action: 'seed', stage: 'execute', ok: r.ok, results: r.results, rolledBack: r.rolledBack, appliedCount: r.appliedCount });
  return {
    ...base,
    ok: r.ok,
    executed: true,
    rolledBack: r.rolledBack,
    appliedCount: r.appliedCount,
    // 성공한 문장은 길어서 빼고, 실패한 것만 SQL과 오류를 돌려준다
    results: r.results.filter((x) => !x.ok).map(({ sql: s, ok: o, skipped, error }) => ({ sql: s.slice(0, 2000), ok: o, ...(skipped ? { skipped } : {}), ...(error ? { error } : {}) })),
  };
}
