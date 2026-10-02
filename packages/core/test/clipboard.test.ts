import { describe, expect, it } from 'vitest';
import { applyCommands, copyTables, emptySchema, generateCreateSql, getDialect, isClip, pasteTables, type Schema } from '../src';

function shop(): Schema {
  const s = applyCommands(emptySchema(), [
    { op: 'createTable', name: 'member', columns: [{ name: 'member_id', type: 'BIGINT', primaryKey: true }] },
    { op: 'createTable', name: 'orders', columns: [{ name: 'order_id', type: 'BIGINT', primaryKey: true }] },
    { op: 'createTable', name: 'product', columns: [{ name: 'product_id', type: 'BIGINT', primaryKey: true }] },
    { op: 'addRelation', parent: 'member', child: 'orders' },
    { op: 'addIndex', table: 'orders', columns: ['member_id'], name: 'ix_orders_member' },
  ]).schema;
  const pos: Record<string, [number, number]> = { member: [0, 0], orders: [300, 0], product: [1000, 1000] };
  for (const t of s.tables) t.position = { x: pos[t.name][0], y: pos[t.name][1] };
  return s;
}
const id = (s: Schema, name: string) => s.tables.find((t) => t.name === name)!.id;

describe('복사·붙여넣기', () => {
  it('새 id·이름으로 붙여넣고, 복사한 테이블끼리의 관계와 인덱스를 새 테이블에 다시 잇는다', () => {
    const s = shop();
    const clip = copyTables(s, [id(s, 'member'), id(s, 'orders')]);
    expect(isClip(JSON.parse(JSON.stringify(clip)))).toBe(true);
    const ids = pasteTables(s, clip);
    expect(s.tables.map((t) => t.name)).toEqual(['member', 'orders', 'product', 'member_2', 'orders_2']);
    const allIds = new Set([...s.tables.map((t) => t.id), ...s.tables.flatMap((t) => t.columns.map((c) => c.id))]);
    expect(allIds.size).toBe(5 + s.tables.reduce((n, t) => n + t.columns.length, 0));

    const newRel = s.relations.find((r) => r.fromTableId === ids[1])!;
    expect(newRel.toTableId).toBe(ids[0]);
    const orders2 = s.tables.find((t) => t.id === ids[1])!;
    expect(newRel.fromColumnIds.every((c) => orders2.columns.some((x) => x.id === c))).toBe(true);
    expect(orders2.indexes[0].name).toBe('ix_orders_member_2');
    expect(orders2.indexes[0].columnIds.every((c) => orders2.columns.some((x) => x.id === c))).toBe(true);
    expect(orders2.position).toEqual({ x: 340, y: 40 });
    // 원래 것은 그대로
    expect(s.relations.filter((r) => r.toTableId === id(s, 'member'))).toHaveLength(1);
    // 붙여넣은 결과로 SQL이 만들어진다
    expect(generateCreateSql(s, getDialect('postgresql'))).toContain('CREATE TABLE orders_2');
  });

  it('부모를 복사하지 않았으면 그 부모에 다시 잇고, 부모가 없는 ERD에서는 FK 컬럼만 남긴다', () => {
    const s = shop();
    const clip = copyTables(s, [id(s, 'orders')]);
    pasteTables(s, clip);
    const orders2 = s.tables.find((t) => t.name === 'orders_2')!;
    expect(s.relations.find((r) => r.fromTableId === orders2.id)!.toTableId).toBe(id(s, 'member'));

    const other = emptySchema();
    pasteTables(other, clip);
    expect(other.tables.map((t) => t.name)).toEqual(['orders']);
    expect(other.tables[0].columns.map((c) => c.name)).toContain('member_id');
    expect(other.relations).toEqual([]);
  });
});
