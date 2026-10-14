// PostgreSQL 실제 서버로 하는 왕복 테스트 (CI에서 컨테이너로 실행).
// ERD_TEST_POSTGRES=postgres://postgres:pw@127.0.0.1:5432 처럼 주소를 주면 실행하고, 없으면 건너뛴다.
// 테스트마다 임시 데이터베이스를 만들고 끝나면 지운다.

import { afterAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { appliedChanges, applyChanges, applyCommands, emptySchema, generateStatements, getDialect, planPull, planPush, skippedChanges, summarizePlan, syncedBaseline, type Schema } from '@erd/core';
import type { ConnectionConfig } from '../src';
import { postgresConnector } from '../src/postgresql';
import { typeRuleMismatches } from './typeCases';
import { logicalNameRoundTrip } from './logicalNameCase';

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
}, 120000); // Windows의 로컬 PostgreSQL은 DB 지우기가 느리다

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

/** DB로 내보내기 화면과 같은 순서: 비교 → 기본 선택(DROP 제외) 실행 → 다시 읽어 기준 시점 저장 */
async function pushLikeDialog(config: ConnectionConfig, erd: Schema, baseline: Schema | null, all = false) {
  const db = (await postgresConnector.introspect(config)).schema;
  const plan = planPush(erd, db, { dialect, baseline: baseline ?? undefined });
  const selected = all ? new Set(plan.diff.changes.map((c) => c.id)) : new Set(plan.defaultSelected);
  const statements = generateStatements(plan.diff, dialect, selected);
  const result = await postgresConnector.execute(config, statements.map((s) => s.sql));
  const after = (await postgresConnector.introspect(config)).schema;
  const applied = appliedChanges(plan.diff.changes, statements, result.results);
  const skipped = skippedChanges(plan.diff.changes, applied);
  const next = syncedBaseline(after, erd, { applied, previous: baseline, skipped, dialect, direction: 'push' });
  return { plan, statements, result, next, selected };
}

async function status(config: ConnectionConfig, erd: Schema, baseline: Schema) {
  const db = (await postgresConnector.introspect(config)).schema;
  const plan = planPull(erd, db, { dialect, baseline });
  return { summary: summarizePlan(plan), changes: plan.diff.changes.map((c) => `${c.summary} [${plan.origins[c.id]}]`) };
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

  it('맞춘 뒤 ERD에서 단 논리명은 "ERD에서 바뀜"으로 내보내고, 실행 후 다시 비교하면 0건', async () => {
    await logicalNameRoundTrip(await freshDatabase(), dialect, postgresConnector);
  }, 60000);

  it('사용자 정의 타입(ENUM): 만들고 → 다시 읽으면 0건, 값 추가·빼기(다시 만들기)·삭제가 실제로 된다', async () => {
    const config = await freshDatabase();
    let schema = applyCommands(emptySchema(), [
      { op: 'createEnum', name: 'BillingStatus', values: ['ISSUED', 'PAID'] },
      { op: 'createEnum', name: 'mood', values: ['ok', 'sad face'] },
      {
        op: 'createTable', name: 'bill',
        columns: [
          { name: 'id', type: 'INT', primaryKey: true },
          { name: 'status', type: 'BillingStatus', nullable: false, default: "'ISSUED'" },
          { name: 'feel', type: 'mood' },
        ],
      },
    ]).schema;
    const first = await push(config, schema);
    expect(first.result.results.filter((r) => !r.ok)).toEqual([]);
    const read = async () => (await postgresConnector.introspect(config)).schema;
    let db = await read();
    expect(db.enums?.map((e) => [e.name, e.values])).toEqual([['BillingStatus', ['ISSUED', 'PAID']], ['mood', ['ok', 'sad face']]]);
    expect(db.tables[0].columns.map((c) => c.type)).toEqual(['INT', 'BillingStatus', 'mood']);
    expect(planPush(schema, db, { dialect }).diff.changes.map((c) => c.summary)).toEqual([]);
    expect(planPull(schema, db, { dialect }).diff.changes.map((c) => c.summary)).toEqual([]);
    await postgresConnector.execute(config, ["INSERT INTO bill (id, status, feel) VALUES (1, 'PAID', 'ok')"]);

    // 값 추가 (중간에)
    schema = applyCommands(schema, [{ op: 'updateEnum', enum: 'BillingStatus', values: ['ISSUED', 'OVERDUE', 'PAID'] }]).schema;
    let r = await push(config, schema);
    expect(r.statements.map((s) => s.sql)).toEqual([`ALTER TYPE "BillingStatus" ADD VALUE 'OVERDUE' BEFORE 'PAID'`]);
    expect(r.result.results.filter((x) => !x.ok)).toEqual([]);
    expect((await read()).enums![0].values).toEqual(['ISSUED', 'OVERDUE', 'PAID']);

    // 값 빼기 → 타입을 다시 만들고 컬럼을 옮긴다 (기본값 포함), 데이터는 남는다
    schema = applyCommands(schema, [{ op: 'updateEnum', enum: 'BillingStatus', values: ['ISSUED', 'PAID'] }]).schema;
    r = await push(config, schema);
    expect(r.result.results.filter((x) => !x.ok)).toEqual([]);
    db = await read();
    expect(db.enums![0].values).toEqual(['ISSUED', 'PAID']);
    expect(planPush(schema, db, { dialect }).diff.changes.map((c) => c.summary)).toEqual([]);

    // DB에서 직접 만든 타입은 가져오기로 ERD에 들어온다
    await postgresConnector.execute(config, ["CREATE TYPE \"Grade\" AS ENUM ('A', 'B')"]);
    db = await read();
    const pull = planPull(schema, db, { dialect });
    expect(pull.diff.changes.map((c) => c.summary)).toEqual(['타입 Grade 생성 (ENUM A, B)']);
    schema = applyChanges(schema, pull.diff, pull.defaultSelected);
    expect(schema.enums?.map((e) => e.name)).toEqual(['BillingStatus', 'mood', 'Grade']);

    // 테이블과 타입을 함께 지우면 테이블 뒤에 DROP TYPE
    schema = applyCommands(schema, [{ op: 'dropTable', table: 'bill' }, { op: 'dropEnum', enum: 'mood' }]).schema;
    const plan = planPush(schema, await read(), { dialect });
    const statements = generateStatements(plan.diff, dialect, new Set(plan.diff.changes.map((c) => c.id)));
    expect(statements.map((s) => s.sql)).toEqual(['DROP TABLE bill', 'DROP TYPE mood']);
    expect((await postgresConnector.execute(config, statements.map((s) => s.sql))).ok).toBe(true);
    expect((await read()).enums?.map((e) => e.name)).toEqual(['BillingStatus', 'Grade']);
  }, 120000);

  it('컬럼 타입을 다른 ENUM·VARCHAR로 바꾸기: 글자를 거쳐 바꾸고, 기본값과 데이터는 남는다', async () => {
    const config = await freshDatabase();
    let schema = applyCommands(emptySchema(), [
      { op: 'createEnum', name: 'LIAR_WINDOW_STATUS', values: ['OPEN', 'CLOSED'] },
      { op: 'createEnum', name: 'INTERROGATION_STATUS', values: ['OPEN', 'CLOSED', 'DONE'] },
      { op: 'createTable', name: 'interrogation', columns: [{ name: 'id', type: 'INT', primaryKey: true }, { name: 'status', type: 'LIAR_WINDOW_STATUS', nullable: false, default: "'OPEN'" }] },
    ]).schema;
    expect((await push(config, schema)).result.ok).toBe(true);
    await postgresConnector.execute(config, ["INSERT INTO interrogation (id, status) VALUES (1, 'CLOSED')"]);
    const read = async () => (await postgresConnector.introspect(config)).schema;

    // ENUM → 다른 ENUM (예전에는 status::INTERROGATION_STATUS 로 바로 바꿔 실패)
    schema = applyCommands(schema, [{ op: 'updateColumn', table: 'interrogation', column: 'status', changes: { type: 'INTERROGATION_STATUS' } }]).schema;
    let r = await push(config, schema);
    expect(r.result.results.filter((x) => !x.ok)).toEqual([]);
    expect(r.statements.map((s) => s.sql).join('\n')).toContain('USING status::text::');
    let db = await read();
    expect(db.tables[0].columns[1].type).toBe('INTERROGATION_STATUS');
    expect(db.tables[0].columns[1].defaultValue).toBe("'OPEN'");
    expect(planPush(schema, db, { dialect }).diff.changes.map((c) => c.summary)).toEqual([]);

    // ENUM → VARCHAR → ENUM
    schema = applyCommands(schema, [{ op: 'updateColumn', table: 'interrogation', column: 'status', changes: { type: 'VARCHAR(20)' } }]).schema;
    r = await push(config, schema);
    expect(r.result.results.filter((x) => !x.ok)).toEqual([]);
    schema = applyCommands(schema, [{ op: 'updateColumn', table: 'interrogation', column: 'status', changes: { type: 'LIAR_WINDOW_STATUS' } }]).schema;
    r = await push(config, schema);
    expect(r.result.results.filter((x) => !x.ok)).toEqual([]);
    db = await read();
    expect(db.tables[0].columns[1].type).toBe('LIAR_WINDOW_STATUS');
    expect(planPush(schema, db, { dialect }).diff.changes.map((c) => c.summary)).toEqual([]);
  }, 120000);

  it('DROP 빼고 ALTER만 내보내면: 남은 것은 체크를 푼 DROP뿐 (ERD에서 바뀜), 가져오기 배지(DB에서 바뀜·둘 다)는 0', async () => {
    const config = await freshDatabase();
    let erd = applyCommands(emptySchema(), [
      { op: 'createEnum', name: 'LIAR_WINDOW_STATUS', values: ['OPEN', 'CLOSED'] },
      { op: 'createEnum', name: 'INTERROGATION_STATUS', values: ['OPEN', 'CLOSED', 'DONE'] },
      { op: 'createTable', name: 'hand_player', columns: [{ name: 'hand_player_id', type: 'BIGINT', primaryKey: true, autoIncrement: true }, { name: 'nick', type: 'VARCHAR(20)' }] },
      { op: 'createTable', name: 'interrogation', columns: [{ name: 'interrogation_id', type: 'BIGINT', primaryKey: true, autoIncrement: true }, { name: 'status', type: 'LIAR_WINDOW_STATUS', nullable: false, default: "'OPEN'" }, { name: 'created_at', type: 'TIMESTAMPTZ', nullable: false, default: 'CURRENT_TIMESTAMP' }] },
      { op: 'createTable', name: 'legacy', columns: [{ name: 'legacy_id', type: 'BIGINT', primaryKey: true }] },
      { op: 'addRelation', parent: 'hand_player', child: 'interrogation' },
    ]).schema;
    // 처음: 전부 내보내 맞춘다
    let r = await pushLikeDialog(config, erd, null, true);
    expect(r.result.ok).toBe(true);
    let baseline = r.next;
    let s = await status(config, erd, baseline);
    expect(s.summary.total).toBe(0);

    // ERD에서: ENUM 타입 바꾸기, 컬럼 추가·타입 변경, 인덱스, 테이블 삭제, ENUM 삭제(안 쓰게 된 것)
    erd = applyCommands(erd, [
      { op: 'updateColumn', table: 'interrogation', column: 'status', changes: { type: 'INTERROGATION_STATUS' } },
      { op: 'updateColumn', table: 'hand_player', column: 'nick', changes: { type: 'VARCHAR(50)' } },
      { op: 'addColumn', table: 'interrogation', column: { name: 'memo', type: 'TEXT' } },
      { op: 'addIndex', table: 'interrogation', columns: ['created_at'] },
      { op: 'dropTable', table: 'legacy' },
      { op: 'dropEnum', enum: 'LIAR_WINDOW_STATUS' },
    ]).schema;
    r = await pushLikeDialog(config, erd, baseline);
    baseline = r.next;
    s = await status(config, erd, baseline);
    expect(s.summary.db + s.summary.conflict).toBe(0);
    expect(s.changes).toEqual(['타입 LIAR_WINDOW_STATUS 생성 (ENUM OPEN, CLOSED) [erd]', 'legacy 테이블 생성 [erd]']);
  }, 120000);

  it('타입 검사가 실패라고 한 것만 실제로 실패한다', async () => {
    const config = await freshDatabase();
    const mismatches = await typeRuleMismatches('postgresql', async (sqls) => (await postgresConnector.execute(config, sqls)).results.find((r) => !r.ok)?.error ?? null);
    expect(mismatches).toEqual([]);
  }, 120000);
});
