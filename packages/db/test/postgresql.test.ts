import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import {
  addColumn,
  addIndex,
  addTable,
  alignToCurrent,
  appliedChanges,
  applyChanges,
  cloneSchema,
  connectTables,
  diffIncoming,
  diffSchemas,
  emptySchema,
  generateStatements,
  getDialect,
  planPull,
  syncedBaseline,
  type Schema,
} from '@erd/core';
import { cleanPgDefault, executePostgres, introspectPostgres, parsePgType, type Queryable } from '../src';

const pgDialect = getDialect('postgresql');

function erd(): Schema {
  const s = emptySchema();
  const member = addTable(s, { name: 'member', logicalName: '회원' });
  addColumn(s, member.id, { name: 'member_id', logicalName: '회원번호', type: 'BIGINT', length: '', primaryKey: true, autoIncrement: true });
  addColumn(s, member.id, { name: 'email', logicalName: '이메일', type: 'VARCHAR', length: '100', nullable: false, unique: true });
  addColumn(s, member.id, { name: 'created_at', type: 'TIMESTAMP', length: '', nullable: false, defaultValue: 'CURRENT_TIMESTAMP' });
  const orders = addTable(s, { name: 'orders', logicalName: '주문' });
  addColumn(s, orders.id, { name: 'order_id', type: 'BIGINT', length: '', primaryKey: true, autoIncrement: true });
  const status = addColumn(s, orders.id, { name: 'status', type: 'VARCHAR', length: '20', nullable: false, defaultValue: "'READY'" });
  addColumn(s, orders.id, { name: 'amount', type: 'DECIMAL', length: '12,2', nullable: false, defaultValue: '0' });
  connectTables(s, { parentTableId: member.id, childTableId: orders.id, onDelete: 'CASCADE' });
  addIndex(s, orders.id, { columnIds: [status.id] });
  return s;
}

/** ERD를 DB에 반영한다: DB를 읽고, ERD와 맞추고, 차이만 실행 (화면 기본값처럼 DROP은 제외) */
async function push(db: Queryable, schema: Schema) {
  const { schema: dbSchema } = await introspectPostgres(db, 'public');
  const base = alignToCurrent(dbSchema, schema);
  const diff = diffSchemas(base, schema, pgDialect);
  const selected = new Set(diff.changes.filter((c) => c.category !== 'drop').map((c) => c.id));
  const statements = generateStatements(diff, pgDialect, selected);
  const result = await executePostgres(db, statements.map((s) => s.sql));
  // 화면처럼: 다시 읽은 DB를 기준 시점으로, 성공한 문장이 만든 식은 DB가 돌려준 모양과 짝으로 기억
  const { schema: after } = await introspectPostgres(db, 'public');
  const baseline = syncedBaseline(after, schema, { applied: appliedChanges(diff.changes, statements, result.results) });
  return { diff, statements, result, baseline };
}

/** DB에서 ERD로 가져올 변경 (기준 시점이 있으면 식 짝을 적용) */
async function pendingChanges(db: Queryable, schema: Schema, baseline?: Schema) {
  const { schema: dbSchema } = await introspectPostgres(db, 'public');
  if (baseline) return planPull(schema, dbSchema, { dialect: pgDialect, baseline }).diff.changes.map((c) => c.summary);
  return diffIncoming(schema, dbSchema, pgDialect).changes.map((c) => c.summary);
}

// PGlite(브라우저용 PostgreSQL)는 시작이 느릴 수 있어(PC가 바쁠 때 5초 넘음) 넉넉히 기다린다
describe('PostgreSQL 연동 (PGlite)', { timeout: 30_000 }, () => {
  it('ERD로 빈 DB에 테이블을 만들고, 다시 읽으면 ERD와 같다', async () => {
    const db = new PGlite();
    const schema = erd();
    const { result } = await push(db, schema);
    expect(result.results.filter((r) => !r.ok)).toEqual([]);
    expect(await pendingChanges(db, schema)).toEqual([]);

    const { schema: read } = await introspectPostgres(db, 'public');
    const member = read.tables.find((t) => t.name === 'member')!;
    expect(member.logicalName).toBe('회원');
    expect(member.columns[0]).toMatchObject({ name: 'member_id', type: 'BIGINT', primaryKey: true, autoIncrement: true, logicalName: '회원번호' });
    expect(read.relations[0]).toMatchObject({ name: 'fk_orders_member', onDelete: 'CASCADE' });
  });

  it('ERD를 고친 뒤 내보내면 바뀐 부분만 실행하고 다른 테이블은 건드리지 않는다', async () => {
    const db = new PGlite();
    const schema = erd();
    await push(db, schema);
    // DB에만 있는 테이블 (ERD 밖에서 만든 것)
    await db.query('CREATE TABLE audit_log (id SERIAL PRIMARY KEY, message TEXT)');

    const next = cloneSchema(schema);
    const orders = next.tables.find((t) => t.name === 'orders')!;
    const memo = addColumn(next, orders.id, { name: 'memo', type: 'VARCHAR', length: '500' });
    addIndex(next, orders.id, { name: 'ix_orders_memo', columnIds: [memo.id] });
    orders.columns.find((c) => c.name === 'status')!.length = '30';

    const { diff, statements, result } = await push(db, next);
    expect(result.ok).toBe(true);
    expect(statements.map((x) => x.sql)).toEqual([
      'ALTER TABLE orders ALTER COLUMN status TYPE VARCHAR(30) USING status::VARCHAR(30)',
      'ALTER TABLE orders ADD COLUMN memo VARCHAR(500)',
      'CREATE INDEX ix_orders_memo ON orders (memo)',
    ]);
    // DB에만 있는 테이블은 DROP 후보로만 나오고 실행하지 않았다
    expect(diff.changes.filter((c) => c.category === 'drop').map((c) => c.summary)).toEqual(['audit_log 테이블 삭제']);
    const { rows } = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_class WHERE relname = 'audit_log'");
    expect(rows[0].n).toBe(1);
    // 다시 읽으면 남은 차이는 audit_log뿐
    expect(await pendingChanges(db, next)).toEqual(['audit_log 테이블 생성']);
  });

  it('DB에서 바뀐 것을 ERD로 가져오면 위치와 논리명은 유지된다', async () => {
    const db = new PGlite();
    const schema = erd();
    schema.tables[0].position = { x: 300, y: 400 };
    await push(db, schema);
    await db.query('ALTER TABLE member ADD COLUMN nickname VARCHAR(30)');
    await db.query("COMMENT ON COLUMN member.nickname IS '별명'");
    await db.query('CREATE UNIQUE INDEX ux_member_nickname ON member (nickname)');

    const { schema: dbSchema } = await introspectPostgres(db, 'public');
    const diff = diffIncoming(schema, dbSchema, pgDialect);
    expect(diff.changes.map((c) => c.summary)).toEqual(['member.nickname 컬럼 추가', 'member 인덱스 생성 (UNIQUE nickname)']);
    const merged = applyChanges(schema, diff);
    const member = merged.tables[0];
    expect(member.position).toEqual({ x: 300, y: 400 });
    expect(member.logicalName).toBe('회원');
    expect(member.columns.at(-1)).toMatchObject({ name: 'nickname', logicalName: '별명' });
    expect(await pendingChanges(db, merged)).toEqual([]);
  });

  it('식(expression) 인덱스: 가져오고, 비교하고, 내보낼 수 있다', async () => {
    const db = new PGlite();
    await db.exec(`
      CREATE TABLE customer (id BIGSERIAL PRIMARY KEY, email VARCHAR(100), metadata JSONB, deleted_at TIMESTAMP);
      CREATE TABLE reviews (id BIGSERIAL PRIMARY KEY, body TEXT NOT NULL);
      CREATE INDEX idx_customer_metadata_sitecd ON customer ((metadata ->> 'sitecd'));
      CREATE INDEX idx_reviews_body_fts ON reviews USING gin (to_tsvector('simple', body));
      CREATE UNIQUE INDEX ux_customer_email_live ON customer (email) WHERE deleted_at IS NULL;
    `);
    const { schema: dbSchema, warnings } = await introspectPostgres(db, 'public');
    expect(warnings).toEqual([]);
    const customer = dbSchema.tables.find((t) => t.name === 'customer')!;
    const reviews = dbSchema.tables.find((t) => t.name === 'reviews')!;
    expect(customer.indexes.find((i) => i.name === 'idx_customer_metadata_sitecd')).toMatchObject({ columnIds: [], expression: "((metadata ->> 'sitecd'::text))" });
    expect(reviews.indexes[0]).toMatchObject({ name: 'idx_reviews_body_fts', method: 'gin', expression: "to_tsvector('simple'::regconfig, body)" });
    const partial = customer.indexes.find((i) => i.name === 'ux_customer_email_live')!;
    expect(partial).toMatchObject({ unique: true, where: '(deleted_at IS NULL)' });
    expect(partial.columnIds).toHaveLength(1);

    // 가져온 그대로면 차이가 없다
    const erdSchema = cloneSchema(dbSchema);
    expect(await pendingChanges(db, erdSchema)).toEqual([]);

    // ERD에서 사람이 쓴 식(형 변환·공백 없이)으로 새 식 인덱스를 만들어 내보내면, 다시 읽어도 같다고 본다
    const erdCustomer = erdSchema.tables.find((t) => t.name === 'customer')!;
    addIndex(erdSchema, erdCustomer.id, { name: 'ix_customer_email_lower', columnIds: [], expression: 'lower(email)' });
    addIndex(erdSchema, erdCustomer.id, { name: 'ix_customer_meta', columnIds: [], expression: 'metadata', method: 'gin' });
    const { statements, result, baseline } = await push(db, erdSchema);
    expect(statements.map((x) => x.sql)).toEqual([
      'CREATE INDEX ix_customer_email_lower ON customer (lower(email))',
      'CREATE INDEX ix_customer_meta ON customer USING gin (metadata)',
    ]);
    expect(result.results.filter((r) => !r.ok)).toEqual([]);
    // PostgreSQL은 lower(email)을 lower((email)::text)로 바꿔 저장하지만, 내보낼 때 기억한 짝으로 같다고 본다
    expect(await pendingChanges(db, erdSchema, baseline)).toEqual([]);

    // 식을 바꾸면 다른 인덱스로 본다
    erdCustomer.indexes.find((i) => i.name === 'ix_customer_email_lower')!.expression = 'upper(email)';
    const changed = await pendingChanges(db, erdSchema, baseline);
    // (DB에서 ERD 방향 비교: ERD의 upper 식은 DB에 없고, DB의 lower 식은 ERD에 없다)
    expect(changed).toEqual(['customer 인덱스 삭제 (upper(email))', 'customer 인덱스 생성 (lower((email)::text))']);
  });

  it('CHECK 제약·계산 컬럼(STORED): 가져오고, 빈 DB에 다시 만들고, 바꾼 것을 내보낸다', async () => {
    const src = new PGlite();
    await src.exec(`
      CREATE TABLE item (id INT PRIMARY KEY, qty INT NOT NULL, price NUMERIC(10,2) NOT NULL,
        total NUMERIC(12,2) GENERATED ALWAYS AS (qty * price) STORED,
        CONSTRAINT ck_item_qty CHECK (qty >= 0), CHECK (price > 0));
      INSERT INTO item (id, qty, price) VALUES (1, 2, 10), (2, 3, 5.5);`);
    const { schema, warnings } = await introspectPostgres(src, 'public');
    expect(warnings).toEqual([]);
    const item = schema.tables[0];
    expect(item.columns.find((c) => c.name === 'total')!.generated).toEqual({ expression: '((qty)::numeric * price)', stored: true });
    expect(item.checks!.map((k) => [k.name, k.expression]).sort()).toEqual([['ck_item_qty', 'qty >= 0'], ['item_price_check', 'price > 0::numeric']]);
    expect(await pendingChanges(src, schema)).toEqual([]);

    // 빈 DB에 다시 만들기
    const copy = new PGlite();
    const { result, baseline } = await push(copy, schema);
    expect(result.results.filter((r) => !r.ok)).toEqual([]);
    expect(await pendingChanges(copy, schema, baseline)).toEqual([]);

    // 바꾸기: qty 검사 삭제, 새 검사 추가, 계산식 변경
    const next = cloneSchema(schema);
    const t = next.tables[0];
    t.checks = t.checks!.filter((k) => k.name !== 'ck_item_qty').concat({ id: 'k_new', name: 'ck_item_qty_max', expression: 'qty <= 1000' });
    t.columns.find((c) => c.name === 'total')!.generated = { expression: 'qty * price * 2', stored: true };
    const diff = diffSchemas(alignToCurrent((await introspectPostgres(src, 'public')).schema, next), next, pgDialect);
    const statements = generateStatements(diff, pgDialect, new Set(diff.changes.map((c) => c.id)));
    const exec = await executePostgres(src, statements.map((x) => x.sql));
    expect(exec.results.filter((r) => !r.ok)).toEqual([]);
    const after = syncedBaseline((await introspectPostgres(src, 'public')).schema, next, { applied: appliedChanges(diff.changes, statements, exec.results) });
    expect(await pendingChanges(src, next, after)).toEqual([]);
    const totals = (await src.query<{ total: string }>('SELECT total FROM item ORDER BY id')).rows.map((r) => Number(r.total));
    expect(totals).toEqual([40, 33]);
  });

  it('실패하면 트랜잭션을 되돌린다', async () => {
    const db = new PGlite();
    const result = await executePostgres(db, ['CREATE TABLE a (id INT)', 'CREATE TABLE a (id INT)', 'CREATE TABLE b (id INT)']);
    expect(result.ok).toBe(false);
    expect(result.rolledBack).toBe(true);
    expect(result.results.map((r) => (r.ok ? 'ok' : r.skipped ? 'skip' : 'fail'))).toEqual(['ok', 'fail', 'skip']);
    const { rows } = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_class WHERE relname IN ('a', 'b')");
    expect(rows[0].n).toBe(0);
  });
});

describe('PostgreSQL 타입 해석', () => {
  it('format_type 결과', () => {
    expect(parsePgType('character varying(100)')).toEqual({ type: 'VARCHAR', length: '100' });
    expect(parsePgType('numeric(12,2)')).toEqual({ type: 'NUMERIC', length: '12,2' });
    expect(parsePgType('timestamp(6) with time zone')).toEqual({ type: 'TIMESTAMPTZ', length: '6' });
    expect(parsePgType('text[]')).toEqual({ type: 'TEXT[]', length: '' });
    expect(parsePgType('integer')).toEqual({ type: 'INT', length: '' });
  });
  it('기본값', () => {
    expect(cleanPgDefault("'READY'::character varying")).toBe("'READY'");
    expect(cleanPgDefault('0')).toBe('0');
    expect(cleanPgDefault("'{}'::text[]")).toBe("'{}'");
    expect(cleanPgDefault('NULL::character varying')).toBe(null);
  });
});
