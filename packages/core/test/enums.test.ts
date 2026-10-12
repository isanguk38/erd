// 사용자 정의 타입 (ENUM): DB별 SQL, 비교, 문서 저장, 명령, DDL 읽기, 따옴표 타입 이름 대소문자
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  applyChanges,
  applyCommands,
  generateCreateSql,
  diffSchemas,
  emptySchema,
  enumAdditions,
  enumKey,
  generateStatements,
  getDialect,
  lintSchema,
  parseDdl,
  readSchema,
  resolveEnumColumns,
  writeSchema,
  type Schema,
} from '../src';

const pg = getDialect('postgresql');
const my = getDialect('mysql');

function base(): Schema {
  return applyCommands(emptySchema(), [
    { op: 'createEnum', name: 'OrderStatus', values: ['READY', 'PAID', 'in progress'] },
    { op: 'createTable', name: 'orders', columns: [{ name: 'id', type: 'BIGINT', primaryKey: true }, { name: 'status', type: 'orderstatus', nullable: false, default: "'READY'" }] },
  ]).schema;
}

describe('사용자 정의 타입 (ENUM)', () => {
  it('이름 비교·값 추가 판단', () => {
    expect(enumKey('public."OrderStatus"')).toBe('orderstatus');
    expect(enumAdditions(['A', 'B'], ['A', 'X', 'B', 'Y'])).toEqual([{ value: 'X', before: 'B' }, { value: 'Y', after: 'B' }]);
    expect(enumAdditions(['A', 'B'], ['B', 'A'])).toBeNull();
    expect(enumAdditions(['A', 'B'], ['A'])).toBeNull();
  });

  it('명령: 컬럼 타입은 ENUM 이름 그대로, 기본 타입 이름·중복·빈 값은 막는다', () => {
    const s = base();
    expect(s.enums).toEqual([expect.objectContaining({ name: 'OrderStatus', values: ['READY', 'PAID', 'in progress'] })]);
    expect(s.tables[0].columns[1].type).toBe('OrderStatus');
    expect(() => applyCommands(s, [{ op: 'createEnum', name: 'varchar', values: ['a'] }])).toThrow(/기본 타입 이름/);
    expect(() => applyCommands(s, [{ op: 'createEnum', name: 'orderSTATUS', values: ['a'] }])).toThrow(/이미 있습니다/);
    expect(() => applyCommands(s, [{ op: 'createEnum', name: 'x', values: [' '] }])).toThrow(/값을 하나 이상/);
    // 이름을 바꾸면 쓰는 컬럼도 함께
    const renamed = applyCommands(s, [{ op: 'updateEnum', enum: 'orderstatus', name: 'order_status' }]).schema;
    expect(renamed.tables[0].columns[1].type).toBe('order_status');
    // 지우면 쓰던 컬럼은 VARCHAR로
    const dropped = applyCommands(s, [{ op: 'dropEnum', enum: 'OrderStatus' }]);
    expect(dropped.messages[0]).toContain('쓰던 컬럼 1개는 VARCHAR로');
    expect(dropped.schema.tables[0].columns[1]).toMatchObject({ type: 'VARCHAR', length: '20' });
    expect(dropped.schema.enums).toEqual([]);
  });

  it('PostgreSQL: CREATE TYPE을 테이블보다 먼저, 대소문자 섞인 이름은 따옴표로', () => {
    const sql = generateCreateSql(base(), pg);
    expect(sql.indexOf(`CREATE TYPE "OrderStatus" AS ENUM ('READY', 'PAID', 'in progress')`)).toBeGreaterThanOrEqual(0);
    expect(sql.indexOf('CREATE TYPE')).toBeLessThan(sql.indexOf('CREATE TABLE'));
    expect(sql).toContain(`status "OrderStatus" NOT NULL DEFAULT 'READY'`);
  });

  it('MySQL: 컬럼마다 ENUM(...)으로 펼친다 (값 안 공백 유지), Oracle·SQL Server는 VARCHAR', () => {
    const sql = generateCreateSql(base(), my);
    expect(sql).toContain("`status` ENUM('READY','PAID','in progress') NOT NULL");
    expect(sql).not.toContain('CREATE TYPE');
    expect(resolveEnumColumns(base(), 'oracle').tables[0].columns[1]).toMatchObject({ type: 'VARCHAR', length: '11' });
    // 설계 검사: ENUM 이름을 모르는 타입이라고 하지 않는다
    expect(lintSchema(base(), 'mysql').filter((i) => i.message.includes('모르는 타입'))).toEqual([]);
    expect(lintSchema(base(), 'postgresql').filter((i) => i.message.includes('모르는 타입'))).toEqual([]);
  });

  it('PostgreSQL 비교: 값 추가는 ADD VALUE, 빼면 타입을 다시 만들고 컬럼을 옮긴다, 지우면 DROP TYPE (테이블 뒤)', () => {
    const before = base();
    const added = applyCommands(before, [{ op: 'updateEnum', enum: 'OrderStatus', values: ['READY', 'PAID', 'SHIPPED', 'in progress'] }]).schema;
    let diff = diffSchemas(before, added, pg);
    expect(diff.changes.map((c) => c.summary)).toEqual(['타입 OrderStatus 값 추가 (SHIPPED)']);
    expect(generateStatements(diff, pg).map((s) => s.sql)).toEqual([`ALTER TYPE "OrderStatus" ADD VALUE 'SHIPPED' BEFORE 'in progress'`]);

    const removed = applyCommands(before, [{ op: 'updateEnum', enum: 'OrderStatus', values: ['READY', 'PAID'] }]).schema;
    diff = diffSchemas(before, removed, pg);
    expect(diff.changes[0].warning).toContain('지운 값(in progress)');
    expect(generateStatements(diff, pg).map((s) => s.sql)).toEqual([
      'ALTER TYPE "OrderStatus" RENAME TO "OrderStatus_old"',
      `CREATE TYPE "OrderStatus" AS ENUM ('READY', 'PAID')`,
      'ALTER TABLE orders ALTER COLUMN status DROP DEFAULT',
      'ALTER TABLE orders ALTER COLUMN status TYPE "OrderStatus" USING status::text::"OrderStatus"',
      "ALTER TABLE orders ALTER COLUMN status SET DEFAULT 'READY'",
      'DROP TYPE "OrderStatus_old"',
    ]);

    const gone = applyCommands(before, [{ op: 'dropTable', table: 'orders' }, { op: 'dropEnum', enum: 'OrderStatus' }]).schema;
    const sql = generateStatements(diffSchemas(before, gone, pg), pg).map((s) => s.sql);
    expect(sql).toEqual(['DROP TABLE orders', 'DROP TYPE "OrderStatus"']);
  });

  it('MySQL 비교: 값을 바꾸면 그 ENUM을 쓰는 컬럼 타입 변경으로', () => {
    const before = base();
    const after = applyCommands(before, [{ op: 'updateEnum', enum: 'OrderStatus', values: ['READY', 'PAID', 'in progress', 'DONE'] }]).schema;
    const diff = diffSchemas(before, after, my);
    // 타입 정의 변경(SQL 없음)과 그 타입을 쓰는 컬럼의 타입 변경
    expect(diff.changes.map((c) => c.kind)).toEqual(['alterEnum', 'alterColumn']);
    expect(generateStatements(diff, my).length).toBe(1);
    expect(generateStatements(diff, my)[0].sql).toContain("ENUM('READY','PAID','in progress','DONE')");
  });

  it('DB에서 읽은 따옴표 타입("BillingStatus")은 대소문자를 지키고, 옛 대문자 값도 ENUM이 있으면 바른 이름으로 SQL을 만든다', () => {
    // 예전 버전이 대문자로 바꿔 저장한 타입
    const old = applyCommands(emptySchema(), [{ op: 'createTable', name: 'bill', columns: [{ name: 'id', type: 'INT', primaryKey: true }, { name: 'status', type: '"BillingStatus"' }] }]).schema;
    expect(old.tables[0].columns[1].type).toBe('"BillingStatus"');
    expect(pg.renderType(old.tables[0].columns[1])).toBe('"BillingStatus"');
    expect(pg.renderType({ ...old.tables[0].columns[1], type: '"mood"' })).toBe('MOOD');
    const broken = structuredClone(old);
    broken.tables[0].columns[1].type = '"BILLINGSTATUS"';
    broken.enums = [{ id: 'e1', name: 'BillingStatus', values: ['ISSUED', 'PAID'] }];
    expect(generateCreateSql(broken, pg)).toContain('status "BillingStatus"');
    // 기본값의 타입 캐스트는 비교할 때 뺀다
    expect(pg.normalizeDefault(`'ISSUED'::"BillingStatus"`)).toBe("'ISSUED'");
  });

  it('DDL 읽기: CREATE TYPE ... AS ENUM, 따옴표 타입', () => {
    const r = parseDdl(`CREATE TYPE "BillingStatus" AS ENUM ('ISSUED', 'PAID');
CREATE TYPE mood AS ENUM ('ok', 'sad');
CREATE TABLE bill (id integer PRIMARY KEY, status "BillingStatus" DEFAULT 'ISSUED'::"BillingStatus", feel mood);`, { dialect: 'postgresql' });
    expect(r.warnings).toEqual([]);
    expect(r.schema.enums?.map((e) => [e.name, e.values])).toEqual([['BillingStatus', ['ISSUED', 'PAID']], ['mood', ['ok', 'sad']]]);
    expect(r.schema.tables[0].columns.map((c) => c.type)).toEqual(['INT', 'BillingStatus', 'mood']);
  });

  it('문서에 저장·읽기, enums를 빼고 저장하면 그대로 둔다', () => {
    const doc = new Y.Doc();
    writeSchema(doc, base());
    expect(readSchema(doc).enums).toEqual(base().enums!.map((e) => ({ ...e, id: expect.any(String) })));
    const { enums: _e, ...withoutEnums } = readSchema(doc);
    writeSchema(doc, withoutEnums);
    expect(readSchema(doc).enums?.length).toBe(1);
    writeSchema(doc, { ...withoutEnums, enums: [] });
    expect(readSchema(doc).enums).toEqual([]);
    // 타입을 한 번도 안 만든 문서도 읽으면 [] (타입 정보를 가진 쪽)
    expect(readSchema(new Y.Doc()).enums).toEqual([]);
  });

  it('타입을 모르는 쪽(enums 없음 — MySQL DB, CREATE TYPE 없는 DDL)과는 타입을 비교하지 않는다', () => {
    const erd = base();
    // MySQL DB에서 읽으면 ENUM은 컬럼마다 ENUM(...)이고 타입 목록은 없다
    const { enums: _e, ...db } = resolveEnumColumns(structuredClone(erd), 'mysql');
    expect(diffSchemas(db, erd, my).changes).toEqual([]);
    expect(diffSchemas(erd, db, my).changes).toEqual([]);
  });

  it('DB에서 가져오기(applyChanges): DB에만 있는 ENUM을 ERD에 넣고, 값이 바뀌면 고친다', () => {
    const erd: Schema = { ...applyCommands(emptySchema(), [{ op: 'createTable', name: 'orders', columns: [{ name: 'id', type: 'BIGINT', primaryKey: true }] }]).schema, enums: [] };
    const db = structuredClone(erd);
    db.enums = [{ id: 'enum_OrderStatus', name: 'OrderStatus', values: ['A', 'B'] }];
    const diff = diffSchemas(erd, db, pg);
    expect(diff.changes.map((c) => c.kind)).toEqual(['createEnum']);
    const pulled = applyChanges(erd, diff);
    expect(pulled.enums).toEqual([{ id: 'enum_OrderStatus', name: 'OrderStatus', values: ['A', 'B'] }]);
    const db2 = structuredClone(db);
    db2.enums![0].values = ['A', 'B', 'C'];
    expect(applyChanges(pulled, diffSchemas(pulled, db2, pg)).enums![0].values).toEqual(['A', 'B', 'C']);
  });
});
