import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  applyCommands,
  areaSchema,
  describeSchema,
  diffSchemas,
  emptySchema,
  getDialect,
  mergeAreaChanges,
  readSchema,
  removeTable,
  writeSchema,
  type Schema,
} from '../src';

const base = (): Schema =>
  applyCommands(emptySchema(), [
    { op: 'createTable', name: 'member', columns: [{ name: 'member_id', type: 'BIGINT', primaryKey: true }] },
    { op: 'createTable', name: 'orders', columns: [{ name: 'order_id', type: 'BIGINT', primaryKey: true }] },
    { op: 'createTable', name: 'order_item', columns: [{ name: 'item_id', type: 'BIGINT', primaryKey: true }] },
    { op: 'addRelation', parent: 'member', child: 'orders' },
    { op: 'addRelation', parent: 'orders', child: 'order_item' },
    { op: 'createArea', name: '회원', tables: ['member'] },
    { op: 'createArea', name: '주문', tables: ['orders', 'order_item'] },
  ]).schema;
const names = (s: Schema, area: string) => {
  const a = s.areas!.find((x) => x.name === area)!;
  return a.tableIds.map((id) => s.tables.find((t) => t.id === id)!.name);
};

describe('주제영역', () => {
  it('명령으로 만들고, 같은 테이블을 여러 영역에 넣고, 옮기고, 빼고, 지운다', () => {
    let s = base();
    expect(names(s, '회원')).toEqual(['member']);
    s = applyCommands(s, [{ op: 'addToArea', area: '주문', tables: ['member'] }]).schema;
    expect(names(s, '주문')).toEqual(['orders', 'order_item', 'member']);
    expect(names(s, '회원')).toEqual(['member']);
    // 회원 영역의 order_item 같은 경우: 다른 영역으로 옮기면 원래 영역에서 빠진다
    s = applyCommands(s, [{ op: 'moveToArea', area: '회원', tables: ['order_item'], from: '주문' }]).schema;
    expect(names(s, '회원')).toEqual(['member', 'order_item']);
    expect(names(s, '주문')).toEqual(['orders', 'member']);
    s = applyCommands(s, [{ op: 'removeFromArea', area: '주문', tables: ['member'] }]).schema;
    expect(names(s, '주문')).toEqual(['orders']);
    expect(s.tables).toHaveLength(3);
    s = applyCommands(s, [{ op: 'updateArea', area: '주문', name: '주문·결제' }, { op: 'dropArea', area: '회원' }]).schema;
    expect(s.areas!.map((a) => a.name)).toEqual(['주문·결제']);
    expect(s.tables).toHaveLength(3);
  });

  it('from 없이 옮기면 다른 모든 영역에서 빠진다', () => {
    let s = applyCommands(base(), [{ op: 'addToArea', area: '주문', tables: ['member'] }, { op: 'createArea', name: '정산' }]).schema;
    s = applyCommands(s, [{ op: 'moveToArea', area: '정산', tables: ['member'] }]).schema;
    expect(names(s, '정산')).toEqual(['member']);
    expect(names(s, '회원')).toEqual([]);
    expect(names(s, '주문')).toEqual(['orders', 'order_item']);
  });

  it('createTable에 area를 주면 그 영역에 넣고 영역 안 테이블 아래에 놓는다', () => {
    const s = applyCommands(base(), [{ op: 'createTable', name: 'payment', area: '주문', columns: [{ name: 'payment_id', type: 'BIGINT', primaryKey: true }] }]).schema;
    expect(names(s, '주문')).toEqual(['orders', 'order_item', 'payment']);
    const area = s.areas!.find((a) => a.name === '주문')!;
    const pay = s.tables.find((t) => t.name === 'payment')!;
    const others = ['orders', 'order_item'].map((n) => s.tables.find((t) => t.name === n)!.position.y);
    expect(area.positions![pay.id].y).toBeGreaterThan(Math.max(...others));
  });

  it('없는 영역·테이블은 오류, 같은 이름 영역은 번호를 붙인다', () => {
    expect(() => applyCommands(base(), [{ op: 'addToArea', area: '없음', tables: ['member'] }])).toThrow(/영역 "없음"이 없습니다/);
    expect(() => applyCommands(base(), [{ op: 'addToArea', area: '주문', tables: ['nope'] }])).toThrow(/테이블 "nope"/);
    const s = applyCommands(base(), [{ op: 'createArea', name: '주문' }]).schema;
    expect(s.areas!.map((a) => a.name)).toEqual(['회원', '주문', '주문 2']);
  });

  it('테이블을 지우면 영역에서도 빠지고, 영역은 SQL 비교에 영향이 없다', () => {
    const s = base();
    const without = structuredClone(s);
    delete without.areas;
    expect(diffSchemas(without, s, getDialect('mysql')).changes).toEqual([]);
    removeTable(s, s.tables.find((t) => t.name === 'orders')!.id);
    expect(names(s, '주문')).toEqual(['order_item']);
  });

  it('Yjs: 영역을 저장·읽고, areas 없이 저장하면 기존 영역을 그대로 둔다', () => {
    const doc = new Y.Doc();
    const s = base();
    writeSchema(doc, s);
    expect(readSchema(doc).areas).toEqual(s.areas);
    const noAreas = structuredClone(s);
    delete noAreas.areas;
    noAreas.tables[0].logicalName = '회원';
    writeSchema(doc, noAreas);
    expect(readSchema(doc).areas).toEqual(s.areas);
    // 지운 테이블은 영역에서 빠진 채로 읽힌다
    writeSchema(doc, { ...noAreas, tables: noAreas.tables.filter((t) => t.name !== 'order_item') });
    expect(readSchema(doc).areas!.find((a) => a.name === '주문')!.tableIds).toHaveLength(1);
    // 영역을 모두 지우면 areas가 없어진다
    writeSchema(doc, { ...readSchema(doc), areas: [] });
    expect(readSchema(doc).areas).toBeUndefined();
  });

  it('영역만 떼어 낸 스키마: 안쪽 관계만, 밖과의 관계는 outside로', () => {
    const s = base();
    const { schema, outside } = areaSchema(s, '주문');
    expect(schema.tables.map((t) => t.name)).toEqual(['orders', 'order_item']);
    expect(schema.relations).toHaveLength(1);
    expect(outside).toEqual([{ relationId: expect.any(String), table: 'orders', outsideTable: 'member' }]);
  });

  it('AI가 읽는 요약에 영역이 나온다', () => {
    expect(describeSchema(base()).areas).toEqual([
      { name: '회원', tables: ['member'] },
      { name: '주문', tables: ['orders', 'order_item'] },
    ]);
  });

  it('제안 반영: base→target 사이에 바뀐 영역만 지금 ERD에 옮긴다 (그 사이 다른 변경은 유지)', () => {
    const b = base();
    const target = applyCommands(b, [
      { op: 'createTable', name: 'payment', area: '주문', columns: [{ name: 'payment_id', type: 'BIGINT', primaryKey: true }] },
      { op: 'createArea', name: '정산', tables: ['orders'] },
      { op: 'removeFromArea', area: '회원', tables: ['member'] },
    ]).schema;
    // 그 사이 사람이 회원 영역에 orders를 넣음
    const current = applyCommands(b, [{ op: 'addToArea', area: '회원', tables: ['orders'] }]).schema;
    // 제안의 테이블 변경이 반영됐다고 치고 (payment 추가)
    const applied = { ...current, tables: [...current.tables, target.tables.find((t) => t.name === 'payment')!] };
    const merged = mergeAreaChanges(applied, b, target);
    expect(names(merged, '주문')).toEqual(['orders', 'order_item', 'payment']);
    expect(names(merged, '정산')).toEqual(['orders']);
    expect(names(merged, '회원')).toEqual(['orders']);
  });
});
