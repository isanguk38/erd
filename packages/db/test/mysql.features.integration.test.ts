// 실제 MySQL 서버로 실무형 기능 확인: FULLTEXT·앞부분 길이·DESC·함수(JSON 포함) 인덱스, ON UPDATE CURRENT_TIMESTAMP,
// 데이터가 있는 DB에 ERD 변경 내보내기, DB에서 바뀐 것 가져오기(3방향), 덤프(SHOW CREATE TABLE) 가져오기.
// ERD_TEST_MYSQL=mysql://user:pass@host:port 가 있을 때만 실행한다. 만든 테스트 DB(erd_it_*)는 끝나면 지운다.
import { afterAll, describe, expect, it } from 'vitest';
import mysql from 'mysql2/promise';
import { addIndex, applyChanges, applyCommands, cloneSchema, generateStatements, getDialect, parseDdl, planPull, planPush, type Schema } from '@erd/core';
import type { ConnectionConfig } from '../src';
import { mysqlConnector } from '../src/mysql';

const url = process.env.ERD_TEST_MYSQL;
const dialect = getDialect('mysql');
const created: string[] = [];
const base = () => {
  const u = new URL(url!);
  return { host: u.hostname, port: Number(u.port), user: decodeURIComponent(u.username), password: decodeURIComponent(u.password) };
};

async function freshDatabase(): Promise<ConnectionConfig> {
  const name = `erd_it_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const conn = await mysql.createConnection(base());
  await conn.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4`);
  await conn.end();
  created.push(name);
  return { dialect: 'mysql', ...base(), database: name };
}
async function run(config: ConnectionConfig, sql: string) {
  const conn = await mysql.createConnection({ ...base(), database: config.database, multipleStatements: true });
  const [rows] = await conn.query(sql);
  await conn.end();
  return rows as Record<string, unknown>[];
}
const read = async (config: ConnectionConfig) => mysqlConnector.introspect(config);
const remaining = async (config: ConnectionConfig, schema: Schema) => planPush(schema, (await read(config)).schema, { dialect }).diff.changes.map((c) => c.summary);
async function push(config: ConnectionConfig, schema: Schema, all = false) {
  const plan = planPush(schema, (await read(config)).schema, { dialect });
  const statements = generateStatements(plan.diff, dialect, all ? new Set(plan.diff.changes.map((c) => c.id)) : plan.defaultSelected);
  const result = await mysqlConnector.execute(config, statements.map((s) => s.sql));
  return { statements, failed: result.results.filter((r) => !r.ok).map((r) => `${r.sql} → ${r.error}`) };
}
const table = (s: Schema, name: string) => s.tables.find((t) => t.name === name)!;
const column = (s: Schema, t: string, c: string) => table(s, t).columns.find((x) => x.name === c)!;
const showCreate = async (config: ConnectionConfig, t: string) =>
  String((await run(config, `SHOW CREATE TABLE \`${t}\``))[0]['Create Table']).replace(/ AUTO_INCREMENT=\d+/, '');

afterAll(async () => {
  if (!url || !created.length) return;
  const conn = await mysql.createConnection(base());
  for (const name of created) await conn.query(`DROP DATABASE IF EXISTS \`${name}\``);
  await conn.end();
});

const FEATURES = `
CREATE TABLE member (
  member_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '회원번호',
  email VARCHAR(100) NOT NULL COMMENT '이메일',
  grade ENUM('BASIC','GOLD','VIP') NOT NULL DEFAULT 'BASIC',
  profile JSON NULL,
  point INT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (member_id),
  UNIQUE KEY ux_member_email (email),
  KEY ix_member_lower ((lower(email))),
  KEY ix_member_city ((CAST(profile->>'$.city' AS CHAR(30)))),
  KEY ix_member_grade_year (grade, (year(created_at))),
  KEY ix_member_created_desc (created_at DESC),
  CONSTRAINT ck_member_point CHECK (point >= 0)
) COMMENT='회원';
CREATE TABLE board (
  board_id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  member_id BIGINT UNSIGNED NULL,
  title VARCHAR(200) NOT NULL,
  body TEXT NOT NULL,
  qty INT NOT NULL DEFAULT 1,
  price DECIMAL(10,2) NOT NULL DEFAULT 0,
  total DECIMAL(12,2) GENERATED ALWAYS AS (qty * price) VIRTUAL,
  KEY ix_board_title_prefix (title(20)),
  FULLTEXT KEY ft_board_body (body),
  CONSTRAINT fk_board_member FOREIGN KEY (member_id) REFERENCES member (member_id) ON DELETE SET NULL ON UPDATE CASCADE
);`;

describe.skipIf(!url)('MySQL 실제 서버: 실무형 기능', () => {
  it('FULLTEXT·앞부분 길이·DESC·함수 인덱스, ON UPDATE를 읽고 빈 DB에 그대로 다시 만든다', async () => {
    const src = await freshDatabase();
    await run(src, FEATURES);
    const { schema, warnings } = await read(src);
    expect(warnings).toEqual([]);
    // CHECK 제약과 계산 컬럼도 가져온다
    expect(table(schema, 'member').checks).toMatchObject([{ name: 'ck_member_point', expression: '(`point` >= 0)' }]);
    expect(column(schema, 'board', 'total').generated).toEqual({ expression: '(`qty` * `price`)', stored: false });
    const idx = (t: string, n: string) => table(schema, t).indexes.find((i) => i.name === n)!;
    expect(idx('board', 'ft_board_body').method).toBe('fulltext');
    expect(idx('board', 'ix_board_title_prefix').expression).toBe('`title`(20)');
    expect(idx('member', 'ix_member_created_desc').expression).toBe('`created_at` DESC');
    expect(idx('member', 'ix_member_city').expression).toContain("'$.city'"); // 따옴표가 \\' 로 남지 않는다
    expect(column(schema, 'member', 'updated_at').onUpdate).toBe('CURRENT_TIMESTAMP');
    expect(await remaining(src, schema)).toEqual([]);

    const copy = await freshDatabase();
    const { failed } = await push(copy, schema);
    expect(failed).toEqual([]);
    expect(await remaining(copy, schema)).toEqual([]);
    const ddl = await showCreate(copy, 'board');
    expect(ddl).toContain('FULLTEXT KEY `ft_board_body` (`body`)');
    expect(ddl).toContain('KEY `ix_board_title_prefix` (`title`(20))');
    expect(await showCreate(copy, 'member')).toContain('ON UPDATE CURRENT_TIMESTAMP');
    // 다시 만든 테이블이 원본과 같은 정의 (인덱스 순서만 다를 수 있어 줄 단위로 비교)
    for (const t of ['member', 'board']) {
      const lines = (ddl: string) => ddl.split(/\r?\n/).map((l) => l.trim().replace(/,$/, '')).sort();
      expect(lines(await showCreate(copy, t))).toEqual(lines(await showCreate(src, t)));
    }
  }, 120_000);

  it('데이터가 있는 DB에 ERD 변경을 내보내고(이름 변경은 데이터 보존), DB에서 바뀐 것은 아직 안 내보낸 설계를 지키며 가져온다', async () => {
    const db = await freshDatabase();
    await run(db, `
      CREATE TABLE member (member_id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, email VARCHAR(100) NOT NULL, name VARCHAR(30) NOT NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, UNIQUE KEY ux_email (email));
      CREATE TABLE orders (order_id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, member_id BIGINT NOT NULL, amount DECIMAL(10,2) NOT NULL DEFAULT 0, memo VARCHAR(100),
        KEY ix_orders_member (member_id), CONSTRAINT fk_orders_member FOREIGN KEY (member_id) REFERENCES member (member_id));
      INSERT INTO member (email, name) VALUES ('a@a.com','에이'),('b@b.com','비');
      INSERT INTO orders (member_id, amount, memo) VALUES (1, 100, '첫 주문'), (2, 200, NULL);`);
    const next = cloneSchema((await read(db)).schema);
    column(next, 'member', 'name').name = 'nickname';
    column(next, 'member', 'nickname').length = '50';
    delete column(next, 'member', 'updated_at').onUpdate;
    const orders = table(next, 'orders');
    orders.indexes = orders.indexes.filter((i) => i.name !== 'ix_orders_member'); // FK가 쓰는 인덱스 지우기
    addIndex(next, orders.id, { name: 'ix_orders_amount_desc', columnIds: [], expression: '`amount` DESC' });
    addIndex(next, orders.id, { name: 'ft_orders_memo', columnIds: [column(next, 'orders', 'memo').id], method: 'fulltext' });
    addIndex(next, table(next, 'member').id, { name: 'ix_member_lower', columnIds: [], expression: 'lower(email)' });
    next.relations[0].onDelete = 'CASCADE';

    const { failed } = await push(db, next, true);
    expect(failed).toEqual([]);
    expect(await remaining(db, next)).toEqual([]);
    expect((await run(db, 'SELECT nickname FROM member ORDER BY member_id')).map((r) => r.nickname)).toEqual(['에이', '비']);
    expect(await showCreate(db, 'member')).not.toContain('ON UPDATE');

    // DB에서 직접 바꾼 것 가져오기: ERD에만 있는 설계(phone)는 지킨다
    const baseline = cloneSchema((await read(db)).schema);
    const erd = cloneSchema(next);
    table(erd, 'member').columns.push({ ...column(erd, 'member', 'email'), id: 'c_phone', name: 'phone', length: '20', nullable: true, logicalName: '전화', comment: '' });
    await run(db, 'ALTER TABLE orders ADD COLUMN paid_at DATETIME NULL; CREATE INDEX ix_orders_paid ON orders ((date(paid_at)));');
    const plan = planPull(erd, (await read(db)).schema, { dialect, baseline });
    const pulled = applyChanges(erd, plan.diff, plan.defaultSelected);
    expect(table(pulled, 'orders').columns.map((c) => c.name)).toContain('paid_at');
    expect(table(pulled, 'orders').indexes.find((i) => i.name === 'ix_orders_paid')?.expression).toMatch(/date/i);
    expect(table(pulled, 'member').columns.map((c) => c.name)).toContain('phone');
  }, 120_000);

  it('CHECK 제약 추가·삭제, 계산식 변경·저장 방식 변경을 데이터가 있는 DB에 내보낸다', async () => {
    const db = await freshDatabase();
    await run(db, `
      CREATE TABLE item (id INT PRIMARY KEY, qty INT NOT NULL, price DECIMAL(10,2) NOT NULL,
        total DECIMAL(12,2) GENERATED ALWAYS AS (qty * price) VIRTUAL,
        CONSTRAINT ck_item_qty CHECK (qty >= 0));
      INSERT INTO item (id, qty, price) VALUES (1, 2, 10.00), (2, 3, 5.50);`);
    const next = cloneSchema((await read(db)).schema);
    const item = table(next, 'item');
    item.checks = [{ id: 'k_price', name: 'ck_item_price', expression: 'price > 0' }]; // qty 검사는 지우고 price 검사 추가
    column(next, 'item', 'total').generated = { expression: 'qty * price * 1.1', stored: true }; // 식 + 저장 방식 변경
    const { failed, statements } = await push(db, next, true);
    expect(failed).toEqual([]);
    expect(statements.map((x) => x.sql).join(' ; ')).toMatch(/DROP CHECK `ck_item_qty`[\s\S]*ADD CONSTRAINT `ck_item_price` CHECK \(price > 0\)/);
    expect(await remaining(db, next)).toEqual([]);
    const totals = (await run(db, 'SELECT total FROM item ORDER BY id')).map((r) => Number(r.total));
    expect(totals).toEqual([22, 18.15]); // 새 식으로 다시 계산됨
    const ddl = await showCreate(db, 'item');
    expect(ddl).toMatch(/STORED/);
    expect(ddl).toContain('ck_item_price');
    expect(ddl).not.toContain('ck_item_qty');
    // 조건에 맞지 않는 데이터가 있으면 CHECK 추가가 실패하고 알려 준다
    const bad = cloneSchema(next);
    table(bad, 'item').checks!.push({ id: 'k_big', name: 'ck_item_big', expression: 'qty > 100' });
    const r = await push(db, bad, true);
    expect(r.failed.join()).toMatch(/ck_item_big/);
  }, 120_000);

  it('CHECK·계산 컬럼이 쓰는 컬럼의 이름을 바꿔도 내보내기가 된다 (MySQL은 그대로는 막는다)', async () => {
    const db = await freshDatabase();
    await run(db, `
      CREATE TABLE pay (id INT PRIMARY KEY, amount INT NOT NULL, doubled INT AS (amount * 2) VIRTUAL, CONSTRAINT ck_pay_amount CHECK (amount >= 0));
      INSERT INTO pay (id, amount) VALUES (1, 10), (2, 20);`);
    const read1 = (await read(db)).schema;
    // 화면·MCP에서 이름을 바꾸면 CHECK 조건·계산식의 이름도 함께 바뀐다
    const next = applyCommands(read1, [{ op: 'updateColumn', table: 'pay', column: 'amount', changes: { name: 'total_amount' } }]).schema;
    expect(table(next, 'pay').checks![0].expression).toContain('total_amount');
    expect(column(next, 'pay', 'doubled').generated!.expression).toContain('total_amount');
    const { failed } = await push(db, next, true);
    expect(failed).toEqual([]);
    expect(await remaining(db, next)).toEqual([]);
    expect((await run(db, 'SELECT total_amount, doubled FROM pay ORDER BY id')).map((r) => [r.total_amount, r.doubled])).toEqual([[10, 20], [20, 40]]);
  }, 120_000);

  it('덤프(SHOW CREATE TABLE)를 DDL로 가져오면 DB를 읽은 것과 같다', async () => {
    const db = await freshDatabase();
    await run(db, FEATURES);
    const dump = [];
    for (const t of ['member', 'board']) dump.push(`${await showCreate(db, t)};`);
    const { schema } = parseDdl(dump.join('\n\n'), { dialect: 'mysql' });
    expect(await remaining(db, schema)).toEqual([]);
  }, 120_000);
});
