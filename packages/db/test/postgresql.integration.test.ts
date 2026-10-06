// PostgreSQL 실제 서버로 하는 왕복 테스트 (CI에서 컨테이너로 실행).
// ERD_TEST_POSTGRES=postgres://postgres:pw@127.0.0.1:5432 처럼 주소를 주면 실행하고, 없으면 건너뛴다.
// 테스트마다 임시 데이터베이스를 만들고 끝나면 지운다.

import { afterAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { appliedChanges, applyChanges, applyCommands, emptySchema, generateStatements, getDialect, planPull, planPush, syncedBaseline, type Schema } from '@erd/core';
import type { ConnectionConfig } from '../src';
import { postgresConnector } from '../src/postgresql';
import { typeRuleMismatches } from './typeCases';

const url = process.env.ERD_TEST_POSTGRES;
const dialect = getDialect('postgresql');
const created: string[] = [];

function parse() {
  const u = new URL(url!);
  return { host: u.hostname, port: Number(u.port), user: decodeURIComponent(u.username), password: decodeURIComponent(u.password) };
}

async function freshDatabase(): Promise<ConnectionConfig> {
  const p = parse();
  const name = `erd_it_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const admin = new pg.Client({ ...p, database: 'postgres' });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  created.push(name);
  return { dialect: 'postgresql', ...p, database: name };
}

afterAll(async () => {
  if (!url || !created.length) return;
  const admin = new pg.Client({ ...parse(), database: 'postgres' });
  await admin.connect();
  for (const name of created) await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.end();
});

/** 틴팅 설계에서 PostgreSQL이 바꿔 저장하는 것들 (IN, BETWEEN, 부분 인덱스, 식 인덱스, 계산 컬럼, 문자열 기본값) */
function erd(): Schema {
  return applyCommands(emptySchema(), [
    {
      op: 'createTable', name: 'film', logicalName: '필름',
      columns: [
        { name: 'film_id', type: 'BIGINT', primaryKey: true, autoIncrement: true },
        { name: 'name', type: 'VARCHAR(100)', nullable: false },
        { name: 'vlt', type: 'SMALLINT', nullable: false },
        { name: 'is_active', type: 'BOOLEAN', nullable: false, default: 'TRUE' },
      ],
    },
    {
      op: 'createTable', name: 'reservation', logicalName: '예약',
      columns: [
        { name: 'reservation_id', type: 'BIGINT', primaryKey: true, autoIncrement: true },
        { name: 'email', type: 'VARCHAR(100)' },
        { name: 'status', type: 'VARCHAR(20)', nullable: false, default: "'REQUESTED'" },
        { name: 'reserved_at', type: 'TIMESTAMPTZ', nullable: false, default: 'CURRENT_TIMESTAMP' },
        { name: 'total_amount', type: 'NUMERIC(10,0)', nullable: false, default: '0' },
        { name: 'discount_amount', type: 'NUMERIC(10,0)', nullable: false, default: '0' },
        { name: 'final_amount', type: 'NUMERIC(10,0)', generated: 'total_amount - discount_amount' },
      ],
    },
    { op: 'addRelation', parent: 'film', child: 'reservation', onDelete: 'SET NULL' },
    { op: 'updateColumn', table: 'reservation', column: 'film_id', changes: { nullable: true } },
    { op: 'addCheck', table: 'film', name: 'ck_film_vlt', expression: 'vlt BETWEEN 0 AND 100' },
    { op: 'addCheck', table: 'reservation', name: 'ck_reservation_status', expression: "status IN ('REQUESTED', 'CONFIRMED', 'DONE')" },
    { op: 'addCheck', table: 'reservation', name: 'ck_reservation_amount', expression: 'NOT discount_amount > total_amount' },
    { op: 'addIndex', table: 'reservation', name: 'ix_reservation_active', columns: ['reserved_at'], where: "status IN ('REQUESTED', 'CONFIRMED')" },
    { op: 'addIndex', table: 'reservation', name: 'ix_reservation_email', expression: 'lower(email)' },
    { op: 'addIndex', table: 'reservation', name: 'ix_reservation_film', columns: ['film_id'] },
  ]).schema;
}

async function push(config: ConnectionConfig, schema: Schema, baseline?: Schema | null) {
  const db = await postgresConnector.introspect(config);
  const plan = planPush(schema, db.schema, { dialect, baseline });
  const statements = generateStatements(plan.diff, dialect, plan.defaultSelected);
  const result = await postgresConnector.execute(config, statements.map((s) => s.sql));
  return { plan, statements, result };
}

describe.skipIf(!url)('PostgreSQL 실제 서버', () => {
  it('내보내기: ERD로 만든 뒤 다시 비교하면 내보내기·가져오기 모두 0건 (DB가 바꿔 쓴 식은 짝으로 기억)', async () => {
    const config = await freshDatabase();
    const schema = erd();
    const { plan, statements, result } = await push(config, schema);
    expect(result.results.filter((r) => !r.ok)).toEqual([]);

    const after = await postgresConnector.introspect(config);
    // PostgreSQL이 실제로 바꿔 저장했는지 (이 테스트가 의미 있는지)
    const film = after.schema.tables.find((t) => t.name === 'film')!;
    expect(film.checks![0]!.expression).not.toBe('vlt BETWEEN 0 AND 100');

    const baseline = syncedBaseline(after.schema, schema, { applied: appliedChanges(plan.diff.changes, statements, result.results) });
    expect(baseline.expressionPairs?.length).toBeGreaterThan(0);
    expect(planPush(schema, after.schema, { dialect, baseline }).diff.changes.map((c) => c.summary)).toEqual([]);
    expect(planPull(schema, after.schema, { dialect, baseline }).diff.changes.map((c) => c.summary)).toEqual([]);

    // ERD에서 식을 고치면 그것만 내보낼 변경으로 나오고, 실행하면 다시 0건
    const next = applyCommands(schema, [
      { op: 'dropCheck', table: 'film', name: 'ck_film_vlt' },
      { op: 'addCheck', table: 'film', name: 'ck_film_vlt', expression: 'vlt BETWEEN 1 AND 100' },
    ]).schema;
    const second = await push(config, next, baseline);
    expect(second.plan.diff.changes.map((c) => `${c.kind}:${c.tableName}`).sort()).toEqual(['addCheck:film', 'dropCheck:film']);
    expect(second.result.ok).toBe(true);
    const again = await postgresConnector.introspect(config);
    const baseline2 = syncedBaseline(again.schema, next, { applied: appliedChanges(second.plan.diff.changes, second.statements, second.result.results), previous: baseline });
    expect(planPush(next, again.schema, { dialect, baseline: baseline2 }).diff.changes.map((c) => c.summary)).toEqual([]);

    // 누가 DB에서 직접 고치면 "DB에서 바뀜"
    await postgresConnector.execute(config, ['ALTER TABLE reservation DROP CONSTRAINT ck_reservation_status', "ALTER TABLE reservation ADD CONSTRAINT ck_reservation_status CHECK (status IN ('REQUESTED', 'DONE'))"]);
    const edited = await postgresConnector.introspect(config);
    const plan3 = planPush(next, edited.schema, { dialect, baseline: baseline2 });
    expect(plan3.diff.changes.length).toBeGreaterThan(0);
    expect(plan3.diff.changes.every((c) => plan3.origins[c.id] === 'db')).toBe(true);
  }, 120000);

  it('가져오기: DB를 빈 ERD로 가져온 뒤 비교하면 내보내기·가져오기 모두 0건', async () => {
    const config = await freshDatabase();
    await push(config, erd());
    const db = await postgresConnector.introspect(config);
    const pulled = applyChanges(emptySchema(), planPull(emptySchema(), db.schema, { dialect }).diff);
    const baseline = syncedBaseline(db.schema, pulled);
    expect(planPush(pulled, db.schema, { dialect, baseline }).diff.changes.map((c) => c.summary)).toEqual([]);
    expect(planPull(pulled, db.schema, { dialect, baseline }).diff.changes.map((c) => c.summary)).toEqual([]);
  }, 120000);

  it('타입 검사가 실패라고 한 것만 실제로 실패한다', async () => {
    const config = await freshDatabase();
    const mismatches = await typeRuleMismatches('postgresql', async (sqls) => (await postgresConnector.execute(config, sqls)).results.find((r) => !r.ok)?.error ?? null);
    expect(mismatches).toEqual([]);
  }, 120000);
});
