import { describe, expect, it } from 'vitest';
import { addIndex, applyCommands, cloneSchema, emptySchema, lintSchema, type LintRule, type Schema } from '../src';

const rules = (s: Schema, dialect = 'postgresql') => lintSchema(s, dialect).map((i) => `${i.rule}:${i.tableName}${i.columnName ? '.' + i.columnName : ''}`);
const only = (s: Schema, rule: LintRule, dialect = 'postgresql') => lintSchema(s, dialect).filter((i) => i.rule === rule);

function good(): Schema {
  return applyCommands(emptySchema(), [
    { op: 'createTable', name: 'member', logicalName: '회원', columns: [
      { name: 'member_id', logicalName: '회원번호', type: 'BIGINT', primaryKey: true },
      { name: 'email', logicalName: '이메일', type: 'VARCHAR(100)' },
    ] },
    { op: 'createTable', name: 'orders', logicalName: '주문', columns: [{ name: 'order_id', logicalName: '주문번호', type: 'BIGINT', primaryKey: true }] },
    { op: 'addRelation', parent: 'member', child: 'orders' },
    { op: 'addIndex', table: 'orders', columns: ['member_id'] },
  ]).schema;
}

describe('설계 검사', () => {
  it('문제가 없는 ERD는 아무것도 나오지 않는다', () => {
    expect(lintSchema(good(), 'postgresql')).toEqual([]);
    expect(lintSchema(good(), 'mysql')).toEqual([]);
  });

  it('기본키 없음, 논리명 없음, 길이 없는 VARCHAR', () => {
    const s = applyCommands(good(), [{ op: 'createTable', name: 'log', columns: [{ name: 'message', type: 'VARCHAR' }] }]).schema;
    s.tables.find((t) => t.name === 'log')!.columns[0].length = '';
    expect(rules(s)).toEqual(
      expect.arrayContaining(['no-primary-key:log', 'missing-logical-name:log', 'missing-logical-name:log.message', 'varchar-no-length:log.message']),
    );
    // 오류가 먼저
    expect(lintSchema(s, 'postgresql')[0].severity).toBe('error');
  });

  it('FK에 인덱스가 없으면 PostgreSQL은 알려주고 고칠 방법을 준다. MySQL은 자동 인덱스라 알리지 않는다', () => {
    const s = good();
    const orders = s.tables.find((t) => t.name === 'orders')!;
    orders.indexes = [];
    const [issue] = only(s, 'fk-without-index');
    expect(issue.columnName).toBe('member_id');
    expect(issue.fix).toEqual({ kind: 'addIndex', tableId: orders.id, columnIds: [orders.columns.find((c) => c.name === 'member_id')!.id] });
    expect(only(s, 'fk-without-index', 'mysql')).toEqual([]);
    expect(only(s, 'fk-without-index', 'mariadb')).toEqual([]);
    // 고치면 사라진다
    addIndex(s, orders.id, { columnIds: (issue.fix as { columnIds: string[] }).columnIds });
    expect(only(s, 'fk-without-index')).toEqual([]);
  });

  it('FK가 기본키의 앞부분이면 인덱스가 있는 것으로 본다 (식별 관계)', () => {
    const s = applyCommands(good(), [
      { op: 'createTable', name: 'order_item', logicalName: '주문상품', columns: [{ name: 'seq', logicalName: '순번', type: 'INT' }] },
      { op: 'addRelation', parent: 'orders', child: 'order_item', identifying: true },
    ]).schema;
    const item = s.tables.find((t) => t.name === 'order_item')!;
    // 식별 관계: order_id가 기본키에 들어가지만 seq 뒤라면 앞부분이 아니다
    expect(item.columns.filter((c) => c.primaryKey).map((c) => c.name)).toEqual(['order_id']);
    expect(only(s, 'fk-without-index')).toEqual([]);
  });

  it('FK 타입이 다르면 오류 (INTEGER와 INT처럼 이름만 다른 것은 같은 것으로)', () => {
    const s = good();
    const fk = s.tables.find((t) => t.name === 'orders')!.columns.find((c) => c.name === 'member_id')!;
    fk.type = 'INT';
    expect(only(s, 'fk-type-mismatch')[0].message).toContain('BIGINT');
    const t = cloneSchema(s);
    t.tables[0].columns[0].type = 'INTEGER';
    expect(only(t, 'fk-type-mismatch')).toEqual([]);
  });

  it('이름 규칙: 많이 쓰는 쪽과 다른 것만, 한 단어 이름은 상관없음, 반반이면 알리지 않음', () => {
    const s = applyCommands(good(), [
      { op: 'createTable', name: 'orderItem', logicalName: '주문상품', columns: [{ name: 'itemId', logicalName: '번호', type: 'BIGINT', primaryKey: true }, { name: 'qty', logicalName: '수량', type: 'INT' }] },
    ]).schema;
    // 테이블: member(한 단어), orders(한 단어), orderItem(camel) → 비교 대상 1개뿐이라 알리지 않음
    // 컬럼: member_id, order_id, member_id(snake) vs itemId(camel) → itemId만
    expect(only(s, 'naming-mixed').map((i) => i.columnName)).toEqual(['itemId']);
    const half = applyCommands(emptySchema(), [
      { op: 'createTable', name: 'a_b', logicalName: 'x', columns: [{ name: 'a_id', logicalName: 'x', type: 'INT', primaryKey: true }] },
      { op: 'createTable', name: 'cD', logicalName: 'x', columns: [{ name: 'cId', logicalName: 'x', type: 'INT', primaryKey: true }] },
    ]).schema;
    expect(only(half, 'naming-mixed')).toEqual([]);
  });

  it('중복 인덱스 (기본키와 같은 것 포함)', () => {
    const s = good();
    const orders = s.tables.find((t) => t.name === 'orders')!;
    addIndex(s, orders.id, { name: 'ix_dup', columnIds: [...orders.indexes[0].columnIds] });
    addIndex(s, orders.id, { name: 'ix_pk', columnIds: orders.columns.filter((c) => c.primaryKey).map((c) => c.id) });
    expect(only(s, 'duplicate-index').map((i) => i.message)).toEqual([
      expect.stringContaining('ix_dup'),
      expect.stringContaining('기본키'),
    ]);
  });

  it('검사는 스키마를 바꾸지 않는다', () => {
    const s = good();
    s.tables[1].indexes = [];
    const before = JSON.stringify(s);
    lintSchema(s, 'postgresql');
    expect(JSON.stringify(s)).toBe(before);
  });
});
