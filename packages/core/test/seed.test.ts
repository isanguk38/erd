import { describe, expect, it } from 'vitest';
import { applyCommands, emptySchema, generateSeedData, getDialect, type Schema } from '../src';

function shop(): Schema {
  return applyCommands(emptySchema(), [
    { op: 'createEnum', name: 'order_status', values: ['READY', 'PAID'] },
    {
      op: 'createTable', name: 'member', logicalName: '회원',
      columns: [
        { name: 'member_id', type: 'BIGINT', primaryKey: true, autoIncrement: true },
        { name: 'member_name', logicalName: '회원명', type: 'VARCHAR(20)', nullable: false },
        { name: 'email', logicalName: '이메일', type: 'VARCHAR(100)', nullable: false, unique: true },
        { name: 'phone', logicalName: '휴대폰번호', type: 'VARCHAR(13)' },
        { name: 'point', type: 'INT', nullable: false, default: '0' },
        { name: 'birth_date', type: 'DATE' },
        { name: 'use_yn', type: 'CHAR(1)', nullable: false, default: "'Y'" },
        { name: 'created_at', type: 'DATETIME', nullable: false, default: 'CURRENT_TIMESTAMP' },
      ],
    },
    {
      op: 'createTable', name: 'orders', logicalName: '주문',
      columns: [
        { name: 'order_id', type: 'BIGINT', primaryKey: true, autoIncrement: true },
        { name: 'status', type: 'order_status', nullable: false },
        { name: 'amount', logicalName: '금액', type: 'DECIMAL(12,2)', nullable: false },
        { name: 'qty', type: 'INT', nullable: false },
      ],
    },
    { op: 'addRelation', parent: 'member', child: 'orders' },
    { op: 'addCheck', table: 'orders', expression: 'qty BETWEEN 1 AND 5' },
    { op: 'createTable', name: 'tag', columns: [{ name: 'tag_id', type: 'INT', primaryKey: true }, { name: 'tag_name', type: 'VARCHAR(30)', nullable: false }] },
    // 다대다: 기본키가 외래키 둘
    { op: 'createTable', name: 'order_tag', columns: [] },
    { op: 'addRelation', parent: 'orders', child: 'order_tag', identifying: true },
    { op: 'addRelation', parent: 'tag', child: 'order_tag', identifying: true },
  ]).schema;
}

const rowsOf = (sql: string[], table: string) =>
  sql.filter((s) => s.includes(`INSERT INTO \`${table}\``)).flatMap((s) => s.split('\n').slice(1).map((l) => l.trim().replace(/,$/, '')));

describe('테스트 데이터', () => {
  it('부모 테이블부터, 행 수만큼, 같은 seed면 같은 SQL', () => {
    const schema = shop();
    const r = generateSeedData(schema, getDialect('mysql'), { rows: 10 });
    expect(r.tables.map((t) => t.name)).toEqual(['member', 'tag', 'orders', 'order_tag']);
    expect(r.tables.map((t) => t.rows)).toEqual([10, 10, 10, 10]);
    expect(r.skipped).toEqual([]);
    expect(generateSeedData(schema, getDialect('mysql'), { rows: 10 }).statements).toEqual(r.statements);
    expect(generateSeedData(schema, getDialect('mysql'), { rows: 10, seed: 2 }).statements).not.toEqual(r.statements);
  });

  it('외래키는 만든 부모 번호, ENUM·CHECK·이름에 맞는 값, 다대다는 겹치지 않게', () => {
    const r = generateSeedData(shop(), getDialect('mysql'), { rows: 10, startId: 101 });
    const member = rowsOf(r.statements, 'member');
    expect(member[0]).toMatch(/^\(101, '[가-힣]{2,4}', 'user101@example\.com', (NULL|'010-\d{4}-\d{4}'), \d+, (NULL|'\d{4}-\d\d-\d\d'), '[YN]', '\d{4}-\d\d-\d\d \d\d:\d\d:\d\d'\)$/);
    for (const row of rowsOf(r.statements, 'orders')) {
      const [, , status, , qty, memberId] = row.match(/^\((\d+), '(\w+)', ([\d.]+), (\d+), (\d+)\)$/)!;
      expect(['READY', 'PAID']).toContain(status);
      expect(Number(qty)).toBeGreaterThanOrEqual(1);
      expect(Number(qty)).toBeLessThanOrEqual(5);
      expect(Number(memberId)).toBeGreaterThanOrEqual(101);
      expect(Number(memberId)).toBeLessThanOrEqual(110);
    }
    const pairs = rowsOf(r.statements, 'order_tag');
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  it('고른 테이블만 + NOT NULL 외래키의 부모는 함께', () => {
    const schema = shop();
    const orders = schema.tables.find((t) => t.name === 'orders')!;
    const r = generateSeedData(schema, getDialect('mysql'), { rows: 5, tableIds: [orders.id] });
    expect(r.tables.map((t) => t.name)).toEqual(['member', 'orders']);
    expect(r.added).toEqual(['member']);
  });

  it('부모보다 많은 다대다 행은 만들 수 없으면 알린다', () => {
    const schema = shop();
    const ids = Object.fromEntries(schema.tables.map((t) => [t.id, t.name === 'order_tag' ? 50 : 3]));
    const r = generateSeedData(schema, getDialect('mysql'), { rowsByTable: ids });
    expect(r.tables.find((t) => t.name === 'order_tag')!.rows).toBe(9);
    expect(r.warnings.some((w) => w.includes('order_tag') && w.includes('9행만'))).toBe(true);
  });

  it('DB마다 문법: PostgreSQL 불리언·IDENTITY 번호 맞추기, SQL Server IDENTITY_INSERT·N 문자열, Oracle 한 행씩·TO_DATE', () => {
    const schema = applyCommands(emptySchema(), [
      { op: 'createTable', name: 'member', columns: [{ name: 'member_id', type: 'BIGINT', primaryKey: true, autoIncrement: true }, { name: 'active', type: 'BOOLEAN', nullable: false }, { name: 'member_name', type: 'VARCHAR(20)', nullable: false }, { name: 'joined', type: 'DATE', nullable: false }] },
    ]).schema;
    const pg = generateSeedData(schema, getDialect('postgresql'), { rows: 2 }).statements;
    expect(pg[0]).toMatch(/\((1|2), (TRUE|FALSE), /);
    expect(pg.at(-1)).toBe(`SELECT setval(pg_get_serial_sequence('member', 'member_id'), (SELECT MAX(member_id) FROM member))`);
    const ms = generateSeedData(schema, getDialect('mssql'), { rows: 2 }).statements;
    expect(ms[0]).toBe('SET IDENTITY_INSERT [member] ON');
    expect(ms[1]).toMatch(/N'[가-힣]+'/);
    expect(ms[2]).toBe('SET IDENTITY_INSERT [member] OFF');
    const ora = generateSeedData(schema, getDialect('oracle'), { rows: 2 }).statements;
    expect(ora.filter((s) => s.startsWith('INSERT'))).toHaveLength(2);
    expect(ora[0]).toMatch(/TO_DATE\('\d{4}-\d\d-\d\d', 'YYYY-MM-DD'\)/);
    expect(ora.at(-1)).toMatch(/START WITH LIMIT VALUE/);
  });

  it('Oracle VARCHAR2 길이는 바이트: 한글 이름이 넘치지 않게 자른다', () => {
    const schema = applyCommands(emptySchema(), [
      { op: 'createTable', name: 't', columns: [{ name: 'id', type: 'NUMBER(10)', primaryKey: true }, { name: 'title', logicalName: '제목', type: 'VARCHAR2(10)', nullable: false }] },
    ]).schema;
    const sql = generateSeedData(schema, getDialect('oracle'), { rows: 3 }).statements.join('\n');
    for (const m of sql.matchAll(/, '([^']*)'\)/g)) expect(new TextEncoder().encode(m[1]).length).toBeLessThanOrEqual(10);
  });

  it('NOT NULL 외래키가 서로를 가리키면 만들 수 없다고 알리고, NULL이 되면 끊어서 만든다', () => {
    const cyclic = (nullable: boolean) =>
      applyCommands(emptySchema(), [
        { op: 'createTable', name: 'a', columns: [{ name: 'a_id', type: 'INT', primaryKey: true }] },
        { op: 'createTable', name: 'b', columns: [{ name: 'b_id', type: 'INT', primaryKey: true }] },
        { op: 'addRelation', parent: 'a', child: 'b' },
        { op: 'addRelation', parent: 'b', child: 'a' },
        ...(nullable ? [{ op: 'updateColumn' as const, table: 'a', column: 'b_id', changes: { nullable: true } }] : [{ op: 'updateColumn' as const, table: 'a', column: 'b_id', changes: { nullable: false } }, { op: 'updateColumn' as const, table: 'b', column: 'a_id', changes: { nullable: false } }]),
      ]).schema;
    expect(generateSeedData(cyclic(false), getDialect('mysql'), { rows: 2 }).skipped.map((s) => s.name).sort()).toEqual(['a', 'b']);
    const ok = generateSeedData(cyclic(true), getDialect('mysql'), { rows: 2 });
    expect(ok.tables.map((t) => t.name)).toEqual(['a', 'b']);
  });
});
