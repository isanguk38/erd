// 실제 MySQL로 하는 왕복 테스트.
// ERD_TEST_MYSQL=mysql://root@127.0.0.1:3407 처럼 주소를 주면 실행하고, 없으면 건너뛴다.
// 테스트마다 임시 데이터베이스를 만들고 끝나면 지운다.

import { afterAll, describe, expect, it } from 'vitest';
import mysql from 'mysql2/promise';
import {
  addColumn,
  addIndex,
  applyChanges,
  applyCommands,
  cloneSchema,
  emptySchema,
  generateStatements,
  getDialect,
  planPull,
  planPush,
  toLink,
  alignDb,
  type Schema,
} from '@erd/core';
import type { ConnectionConfig } from '../src';
import { mysqlConnector } from '../src/mysql';

const url = process.env.ERD_TEST_MYSQL;
const dialect = getDialect('mysql');
const created: string[] = [];

async function admin() {
  const u = new URL(url!);
  return mysql.createConnection({ host: u.hostname, port: Number(u.port), user: decodeURIComponent(u.username), password: decodeURIComponent(u.password) });
}

async function freshDatabase(): Promise<ConnectionConfig> {
  const u = new URL(url!);
  const name = `erd_it_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const conn = await admin();
  await conn.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4`);
  await conn.end();
  created.push(name);
  return { dialect: 'mysql', host: u.hostname, port: Number(u.port), user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), database: name };
}

const connect = (c: ConnectionConfig, multipleStatements = false) =>
  mysql.createConnection({ host: c.host, port: c.port, user: c.user, password: c.password, database: c.database, multipleStatements });

async function run(config: ConnectionConfig, sql: string) {
  const conn = await connect(config, true);
  await conn.query(sql);
  await conn.end();
}

afterAll(async () => {
  if (!url || !created.length) return;
  const conn = await admin();
  for (const name of created) await conn.query(`DROP DATABASE IF EXISTS \`${name}\``);
  await conn.end();
});

function erd(): Schema {
  return applyCommands(emptySchema(), [
    {
      op: 'createTable', name: 'member', logicalName: '회원',
      columns: [
        { name: 'member_id', logicalName: '회원번호', type: 'BIGINT', primaryKey: true, autoIncrement: true },
        { name: 'email', logicalName: '이메일', type: 'VARCHAR(100)', nullable: false, unique: true },
        { name: 'is_active', logicalName: '사용여부', type: 'BOOLEAN', nullable: false, default: '1' },
        { name: 'grade', type: 'VARCHAR(10)', nullable: false, default: "'BASIC'" },
        { name: 'point', type: 'INT UNSIGNED', nullable: false, default: '0' },
        { name: 'created_at', logicalName: '가입일시', type: 'DATETIME', nullable: false, default: 'CURRENT_TIMESTAMP' },
      ],
    },
    {
      op: 'createTable', name: 'orders', logicalName: '주문',
      columns: [
        { name: 'order_id', type: 'BIGINT', primaryKey: true, autoIncrement: true },
        { name: 'amount', logicalName: '금액', type: 'DECIMAL(12,2)', nullable: false, default: '0.00' },
        { name: 'memo', type: 'TEXT' },
        { name: 'status', type: "ENUM('READY','PAID','CANCEL')", nullable: false, default: "'READY'" },
      ],
    },
    { op: 'addRelation', parent: 'member', child: 'orders', onDelete: 'CASCADE' },
    { op: 'addIndex', table: 'orders', columns: ['member_id', 'status'], name: 'ix_orders_member_status' },
  ]).schema;
}

async function push(config: ConnectionConfig, schema: Schema, options: { links?: ReturnType<typeof toLink>[]; baseline?: Schema } = {}) {
  const db = await mysqlConnector.introspect(config);
  const plan = planPush(schema, db.schema, { dialect, ...options });
  const statements = generateStatements(plan.diff, dialect, plan.defaultSelected);
  const result = await mysqlConnector.execute(config, statements.map((s) => s.sql));
  return { plan, statements, result };
}

async function remaining(config: ConnectionConfig, schema: Schema) {
  const db = await mysqlConnector.introspect(config);
  return planPush(schema, db.schema, { dialect }).diff.changes.map((c) => c.summary);
}

describe.skipIf(!url)('MySQL 실제 서버', () => {
  it('ERD로 만들고 다시 읽으면 ERD와 같다 (한글 코멘트, UNIQUE, ENUM, DECIMAL, 기본값, FK CASCADE, 복합 인덱스)', async () => {
    const config = await freshDatabase();
    const schema = erd();
    const { result, statements } = await push(config, schema);
    expect(result.results.filter((r) => !r.ok)).toEqual([]);
    expect(statements.every((s) => s.category === 'create')).toBe(true);
    expect(await remaining(config, schema)).toEqual([]);

    const { schema: read, serverVersion } = await mysqlConnector.introspect(config);
    expect(serverVersion).toMatch(/^MySQL 8/);
    const member = read.tables.find((t) => t.name === 'member')!;
    expect(member.logicalName).toBe('회원');
    expect(member.columns.map((c) => `${c.name}:${c.type}`)).toEqual([
      'member_id:BIGINT', 'email:VARCHAR', 'is_active:BOOLEAN', 'grade:VARCHAR', 'point:INT UNSIGNED', 'created_at:DATETIME',
    ]);
    const orders = read.tables.find((t) => t.name === 'orders')!;
    expect(orders.columns.find((c) => c.name === 'status')).toMatchObject({ type: 'ENUM', length: "'READY','PAID','CANCEL'", defaultValue: "'READY'" });
    expect(read.relations[0]).toMatchObject({ name: 'fk_orders_member', onDelete: 'CASCADE' });
  });

  it('ERD를 고치면 바뀐 부분만 실행하고, DB에만 있는 테이블과 데이터는 그대로 둔다', async () => {
    const config = await freshDatabase();
    const schema = erd();
    await push(config, schema);
    await run(config, "CREATE TABLE audit_log (id INT AUTO_INCREMENT PRIMARY KEY, msg TEXT); INSERT INTO member (email) VALUES ('a@a.com');");

    const next = cloneSchema(schema);
    const member = next.tables.find((t) => t.name === 'member')!;
    const orders = next.tables.find((t) => t.name === 'orders')!;
    member.columns.find((c) => c.name === 'email')!.length = '200';
    const phone = addColumn(next, member.id, { name: 'phone', logicalName: '전화번호', type: 'VARCHAR', length: '20' }, 2);
    addIndex(next, member.id, { columnIds: [phone.id] });
    orders.columns.find((c) => c.name === 'memo')!.name = 'note'; // 이름 변경 (데이터 보존해야 함)

    const first = await mysqlConnector.introspect(config);
    const plan = planPush(next, first.schema, { dialect });
    expect(plan.renames).toMatchObject([{ kind: 'column', dbName: 'memo', erdName: 'note' }]);

    const { statements, result } = await push(config, next, { links: plan.renames.map(toLink) });
    expect(result.ok).toBe(true);
    expect(statements.map((s) => s.sql)).toEqual([
      'ALTER TABLE `member` MODIFY COLUMN `email` VARCHAR(200) NOT NULL COMMENT \'이메일\'',
      'ALTER TABLE `member` ADD COLUMN `phone` VARCHAR(20) NULL COMMENT \'전화번호\' AFTER `email`',
      'ALTER TABLE `orders` CHANGE COLUMN `memo` `note` TEXT NULL',
      'CREATE INDEX `ix_member_phone` ON `member` (`phone`)',
    ]);
    // 남은 차이는 DB에만 있는 audit_log뿐이고, 데이터도 그대로
    expect(await remaining(config, next)).toEqual(['audit_log 테이블 삭제']);
    const conn = await connect(config);
    const [rows] = await conn.query('SELECT email FROM member');
    await conn.end();
    expect(rows).toEqual([{ email: 'a@a.com' }]);
  });

  it('기본키·UNIQUE·인덱스·FK 변경과 삭제도 왕복된다', async () => {
    const config = await freshDatabase();
    const schema = erd();
    await push(config, schema);
    const next = cloneSchema(schema);
    const member = next.tables.find((t) => t.name === 'member')!;
    const orders = next.tables.find((t) => t.name === 'orders')!;
    member.columns.find((c) => c.name === 'email')!.unique = false; // UNIQUE 해제
    orders.indexes = []; // 복합 인덱스 삭제
    next.relations[0].onDelete = 'SET NULL'; // FK 변경 → DROP + ADD
    orders.columns.find((c) => c.name === 'member_id')!.nullable = true;
    const { result } = await push(config, next);
    expect(result.results.filter((r) => !r.ok)).toEqual([]);
    expect(await remaining(config, next)).toEqual([]);
  });

  it('DB를 직접 고친 것을 가져오면 DB 변경만 반영하고, 아직 안 넣은 ERD 설계는 지킨다 (3방향)', async () => {
    const config = await freshDatabase();
    const schema = erd();
    await push(config, schema);
    // 기준 시점 저장 (내보내기 직후)
    const baseline = alignDb((await mysqlConnector.introspect(config)).schema, schema);

    // 누군가 DB를 직접 고침
    await run(config, "ALTER TABLE orders ADD COLUMN paid_at DATETIME NULL COMMENT '결제일시'; CREATE INDEX ix_orders_paid ON orders (paid_at);");
    // 그 사이 ERD에서는 새 컬럼을 설계 (아직 DB에 안 넣음)
    const erdNow = cloneSchema(schema);
    addColumn(erdNow, erdNow.tables[0].id, { name: 'nickname', type: 'VARCHAR', length: '30' });

    const db = await mysqlConnector.introspect(config);
    const plan = planPull(erdNow, db.schema, { dialect, baseline });
    const view = plan.diff.changes.map((c) => `${plan.origins[c.id]}:${c.summary}`).sort();
    expect(view).toEqual(['db:orders 인덱스 생성 (paid_at)', 'db:orders.paid_at 컬럼 추가', 'erd:member.nickname 컬럼 삭제']);
    const merged = applyChanges(erdNow, plan.diff, plan.defaultSelected);
    expect(merged.tables[0].columns.map((c) => c.name)).toContain('nickname');
    expect(merged.tables[1].columns.find((c) => c.name === 'paid_at')?.logicalName).toBe('결제일시');

    // 내보내기 쪽에서 보면 nickname만 실행 대상이고 DB의 paid_at은 되돌리지 않는다
    const pushPlan = planPush(merged, db.schema, { dialect, baseline });
    expect(generateStatements(pushPlan.diff, dialect, pushPlan.defaultSelected).map((s) => s.sql)).toEqual([
      'ALTER TABLE `member` ADD COLUMN `nickname` VARCHAR(30) NULL AFTER `created_at`',
    ]);
  });

  it('실패하면 그 자리에서 멈추고 몇 문장까지 반영됐는지 알려준다', async () => {
    const config = await freshDatabase();
    const result = await mysqlConnector.execute(config, ['CREATE TABLE a (id INT)', 'CREATE TABLE a (id INT)', 'CREATE TABLE b (id INT)']);
    expect(result.ok).toBe(false);
    expect(result.rolledBack).toBe(false);
    expect(result.appliedCount).toBe(1);
    expect(result.results.map((r) => (r.ok ? 'ok' : r.skipped ? 'skip' : 'fail'))).toEqual(['ok', 'fail', 'skip']);
    expect(result.results[1].error).toContain("'a' already exists");
  });
});
