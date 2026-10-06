import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  alignToCurrent,
  applyChanges,
  applyCommands,
  cloneSchema,
  diffSchemas,
  emptySchema,
  generateStatements,
  getDialect,
  parseDdl,
  readSchema,
  writeSchema,
  type DialectId,
  type Schema,
} from '../src';

function item(stored = false): Schema {
  return applyCommands(emptySchema(), [
    { op: 'createTable', name: 'item', columns: [
      { name: 'id', type: 'INT', primaryKey: true },
      { name: 'qty', type: 'INT', nullable: false },
      { name: 'price', type: 'DECIMAL(10,2)', nullable: false },
      { name: 'total', type: 'DECIMAL(12,2)', generated: 'qty * price', generatedStored: stored },
    ] },
    { op: 'addCheck', table: 'item', name: 'ck_item_qty', expression: 'qty >= 0' },
    { op: 'addCheck', table: 'item', expression: 'price > 0' },
  ]).schema;
}
const sqlOf = (dialect: DialectId, from: Schema, to: Schema) => {
  const d = getDialect(dialect);
  const diff = diffSchemas(from, to, d);
  return { diff, sql: generateStatements(diff, d, new Set(diff.changes.map((c) => c.id))).map((x) => x.sql) };
};

describe('CHECK 제약·계산 컬럼', () => {
  it('DB 종류별 CREATE 문법', () => {
    const mysql = sqlOf('mysql', emptySchema(), item()).sql.join('\n');
    expect(mysql).toContain('`total` DECIMAL(12,2) GENERATED ALWAYS AS (qty * price) VIRTUAL NULL');
    expect(mysql).toContain('ALTER TABLE `item` ADD CONSTRAINT `ck_item_qty` CHECK (qty >= 0)');
    expect(mysql).toContain('ALTER TABLE `item` ADD CONSTRAINT `ck_item_2` CHECK (price > 0)'); // 이름이 없으면 ck_테이블_번호
    expect(sqlOf('mysql', emptySchema(), item(true)).sql.join('\n')).toContain('GENERATED ALWAYS AS (qty * price) STORED');
    expect(sqlOf('postgresql', emptySchema(), item(true)).sql.join('\n')).toContain('total NUMERIC(12,2) GENERATED ALWAYS AS (qty * price) STORED');
    expect(sqlOf('oracle', emptySchema(), item()).sql.join('\n')).toMatch(/TOTAL"? NUMBER\(12,2\) GENERATED ALWAYS AS \(qty \* price\) VIRTUAL/i);
    expect(sqlOf('mssql', emptySchema(), item(true)).sql.join('\n')).toContain('[total] AS (qty * price) PERSISTED');
  });

  it('지원하지 않는 저장 방식은 주의를 단다 (PostgreSQL VIRTUAL, Oracle STORED)', () => {
    const pg = sqlOf('postgresql', emptySchema(), item(false)).diff.changes.find((c) => c.kind === 'createTable')!;
    expect(pg.warning).toContain('STORED(값 저장)로 만듭니다');
    const ora = sqlOf('oracle', emptySchema(), item(true)).diff.changes.find((c) => c.kind === 'createTable')!;
    expect(ora.warning).toContain('VIRTUAL로 만듭니다');
    expect(sqlOf('mysql', emptySchema(), item()).diff.changes.find((c) => c.kind === 'createTable')!.warning).toBeUndefined();
  });

  it('바꾸기: CHECK 추가·삭제, 계산식이 바뀌면 컬럼을 지우고 다시 만든다', () => {
    const before = item();
    const after = applyCommands(before, [
      { op: 'dropCheck', table: 'item', name: 'ck_item_qty' },
      { op: 'addCheck', table: 'item', name: 'ck_item_qty_max', expression: 'qty <= 1000' },
      { op: 'updateColumn', table: 'item', column: 'total', changes: { generated: 'qty * price * 2' } },
    ]).schema;
    const { diff, sql } = sqlOf('mysql', before, after);
    expect(diff.changes.map((c) => c.summary)).toEqual([
      'item CHECK 삭제 (qty >= 0)',
      'item CHECK 추가 (qty <= 1000)',
      'item.total 변경: 계산식 qty * price * 2',
    ]);
    expect(sql).toEqual([
      'ALTER TABLE `item` DROP CHECK `ck_item_qty`',
      'ALTER TABLE `item` DROP COLUMN `total`',
      'ALTER TABLE `item` ADD COLUMN `total` DECIMAL(12,2) GENERATED ALWAYS AS (qty * price * 2) VIRTUAL NULL AFTER `price`',
      'ALTER TABLE `item` ADD CONSTRAINT `ck_item_qty_max` CHECK (qty <= 1000)',
    ]);
    expect(sqlOf('postgresql', before, after).sql[0]).toBe('ALTER TABLE item DROP CONSTRAINT ck_item_qty');
    expect(sqlOf('mariadb', before, after).sql[0]).toBe('ALTER TABLE `item` DROP CONSTRAINT `ck_item_qty`');
    // 식의 공백·괄호 차이는 같은 것으로 본다
    const same = cloneSchema(before);
    same.tables[0].checks![0].expression = '(`qty` >= 0)';
    same.tables[0].columns[3].generated = { expression: '(`qty` * `price`)', stored: false };
    expect(diffSchemas(before, same, getDialect('mysql')).changes).toEqual([]);
  });

  it('DDL 가져오기: 테이블·컬럼 CHECK, GENERATED ALWAYS AS / AS (식) STORED', () => {
    const { schema, warnings } = parseDdl(
      `CREATE TABLE item (
         id INT PRIMARY KEY,
         qty INT NOT NULL CHECK (qty >= 0),
         price NUMERIC(10,2) NOT NULL CONSTRAINT ck_price CHECK (price > 0),
         total NUMERIC(12,2) GENERATED ALWAYS AS (qty * price) STORED,
         CONSTRAINT ck_item_sane CHECK (total < 1000000)
       );`,
      { dialect: 'postgresql' },
    );
    expect(warnings).toEqual([]);
    const t = schema.tables[0];
    expect(t.checks!.map((k) => [k.name, k.expression])).toEqual([['', 'qty >= 0'], ['ck_price', 'price > 0'], ['ck_item_sane', 'total < 1000000']]);
    expect(t.columns.find((c) => c.name === 'total')!.generated).toEqual({ expression: 'qty * price', stored: true });
    const my = parseDdl('CREATE TABLE `t` (`a` INT, `b` INT AS (`a` * 2) VIRTUAL, `c` INT GENERATED ALWAYS AS (`a` + 1) STORED);', { dialect: 'mysql' }).schema.tables[0];
    expect(my.columns.map((c) => c.generated)).toEqual([undefined, { expression: '`a` * 2', stored: false }, { expression: '`a` + 1', stored: true }]);
  });

  it('DB에서 읽은 CHECK(DB가 지은 이름)는 ERD의 이름 없는 같은 식과 짝지어진다', () => {
    const erd = item();
    const db = cloneSchema(erd);
    db.tables[0].checks = db.tables[0].checks!.map((k) => ({ ...k, id: `db_${k.id}`, name: k.name || 'item_chk_2' }));
    const aligned = alignToCurrent(db, erd);
    expect(diffSchemas(aligned, erd, getDialect('mysql')).changes).toEqual([]);
  });

  it('함께 편집(Y 문서)에 저장했다 읽어도 남고, DB 변경 가져오기에도 반영된다', () => {
    const s = item(true);
    const doc = new Y.Doc();
    writeSchema(doc, s);
    const back = readSchema(doc);
    expect(back.tables[0].checks!.map((k) => k.expression)).toEqual(['qty >= 0', 'price > 0']);
    expect(back.tables[0].columns[3].generated).toEqual({ expression: 'qty * price', stored: true });

    const changed = applyCommands(s, [{ op: 'addCheck', table: 'item', name: 'ck_new', expression: 'qty < 5' }]).schema;
    const diff = diffSchemas(s, changed, getDialect('mysql'));
    expect(applyChanges(s, diff).tables[0].checks!.map((k) => k.name)).toEqual(['ck_item_qty', '', 'ck_new']);
  });

  it('컬럼 이름을 바꾸면 CHECK·계산식·식 인덱스도 따라 바뀌고, SQL은 지우기 → 이름 변경 → 다시 만들기 순서', () => {
    const before = applyCommands(item(), [{ op: 'addIndex', table: 'item', name: 'ix_q', expression: '(qty + 1)' }]).schema;
    const after = applyCommands(before, [{ op: 'updateColumn', table: 'item', column: 'qty', changes: { name: 'quantity' } }]).schema;
    const t = after.tables[0];
    expect(t.checks![0].expression).toBe('quantity >= 0');
    expect(t.columns.find((c) => c.name === 'total')!.generated!.expression).toBe('quantity * price');
    expect(t.indexes[0].expression).toBe('(quantity + 1)');
    const sql = sqlOf('mysql', before, after).sql;
    const at = (re: RegExp) => sql.findIndex((x) => re.test(x));
    expect(at(/DROP CHECK `ck_item_qty`/)).toBeLessThan(at(/CHANGE COLUMN `qty` `quantity`/));
    expect(at(/DROP COLUMN `total`/)).toBeLessThan(at(/CHANGE COLUMN `qty` `quantity`/));
    expect(at(/ADD COLUMN `total`.*quantity \* price/)).toBeGreaterThan(at(/CHANGE COLUMN `qty` `quantity`/));
    expect(at(/ADD CONSTRAINT `ck_item_qty` CHECK \(quantity >= 0\)/)).toBeGreaterThan(at(/CHANGE COLUMN `qty` `quantity`/));
  });

  it('MCP: get_schema 요약에 CHECK·계산식이 보이고, 없는 CHECK를 지우면 알려 준다', () => {
    expect(() => applyCommands(item(), [{ op: 'dropCheck', table: 'item', name: 'nope' }])).toThrow(/CHECK 제약이 없습니다/);
    expect(() => applyCommands(item(), [{ op: 'addCheck', table: 'item', expression: ' ' }])).toThrow(/CHECK 식/);
  });
});
