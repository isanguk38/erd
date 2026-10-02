import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  applyCommands,
  assignAreas,
  cloneSchema,
  copyTables,
  createArea,
  diffSchemas,
  emptySchema,
  generateCreateSql,
  getDialect,
  hiddenTableIds,
  isClip,
  moveArea,
  pasteTables,
  readSchema,
  removeArea,
  removeTable,
  writeSchema,
  type Schema,
} from '../src';

const size = () => ({ width: 200, height: 100 });

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

describe('영역', () => {
  it('고른 테이블을 감싸는 영역을 만들고, 영역을 옮기면 안의 테이블만 같이 옮겨진다', () => {
    const s = shop();
    const area = createArea(s, { name: '주문', tableIds: [id(s, 'member'), id(s, 'orders')], sizeOf: size });
    expect(area.tableIds).toHaveLength(2);
    expect(area.position.x).toBeLessThan(0);
    expect(area.position.x + area.size.width).toBeGreaterThan(500);

    moveArea(s, area.id, { x: area.position.x + 100, y: area.position.y + 50 });
    expect(s.tables.find((t) => t.name === 'member')!.position).toEqual({ x: 100, y: 50 });
    expect(s.tables.find((t) => t.name === 'orders')!.position).toEqual({ x: 400, y: 50 });
    expect(s.tables.find((t) => t.name === 'product')!.position).toEqual({ x: 1000, y: 1000 });
  });

  it('테이블을 영역 안으로/밖으로 옮기면 소속이 바뀐다. 접힌 영역의 테이블은 그대로', () => {
    const s = shop();
    const area = createArea(s, { tableIds: [id(s, 'member')], sizeOf: size });
    const product = s.tables.find((t) => t.name === 'product')!;
    product.position = { x: area.position.x + 50, y: area.position.y + 50 };
    assignAreas(s, [product.id], size);
    expect(s.areas![0].tableIds).toContain(product.id);

    product.position = { x: 5000, y: 5000 };
    assignAreas(s, [product.id], size);
    expect(s.areas![0].tableIds).not.toContain(product.id);

    s.areas![0].collapsed = true;
    const member = s.tables.find((t) => t.name === 'member')!;
    member.position = { x: 9000, y: 9000 };
    assignAreas(s, 'all', size);
    expect(s.areas![0].tableIds).toContain(member.id);
    expect(hiddenTableIds(s).has(member.id)).toBe(true);
  });

  it('테이블은 한 영역에만 속하고, 테이블을 지우면 영역에서도 빠진다. 영역을 지워도 테이블은 남는다', () => {
    const s = shop();
    const a = createArea(s, { tableIds: [id(s, 'member'), id(s, 'orders')], sizeOf: size });
    const b = createArea(s, { tableIds: [id(s, 'orders')], sizeOf: size });
    expect(s.areas!.find((x) => x.id === a.id)!.tableIds).toEqual([id(s, 'member')]);
    expect(b.tableIds).toEqual([id(s, 'orders')]);
    removeTable(s, id(s, 'member'));
    expect(s.areas!.find((x) => x.id === a.id)!.tableIds).toEqual([]);
    removeArea(s, a.id);
    expect(s.areas!.map((x) => x.id)).toEqual([b.id]);
    expect(s.tables).toHaveLength(2);
  });

  it('영역은 SQL·비교에 영향이 없다', () => {
    const base = shop();
    const withArea = cloneSchema(base);
    createArea(withArea, { tableIds: [id(withArea, 'member')], sizeOf: size });
    const dialect = getDialect('mysql');
    expect(diffSchemas(base, withArea, dialect).changes).toEqual([]);
    expect(generateCreateSql(withArea, dialect)).toBe(generateCreateSql(base, dialect));
  });
});

describe('영역 저장 (Yjs 문서)', () => {
  it('영역을 저장하고 다시 읽는다. 영역을 안 쓰면 스키마 모양이 그대로다', () => {
    const doc = new Y.Doc();
    const s = shop();
    writeSchema(doc, s);
    expect('areas' in readSchema(doc)).toBe(false);

    createArea(s, { name: '주문', tableIds: [id(s, 'orders')], sizeOf: size });
    s.areas![0].collapsed = true;
    writeSchema(doc, s);
    const read = readSchema(doc);
    expect(read.areas).toHaveLength(1);
    expect(read.areas![0]).toMatchObject({ name: '주문', tableIds: [id(s, 'orders')], collapsed: true });
  });

  it('areas가 없는 스키마로 저장하면 (DB 가져오기·버전 복원 등) 기존 영역을 지우지 않는다. 빈 배열이면 지운다', () => {
    const doc = new Y.Doc();
    const s = shop();
    createArea(s, { tableIds: [id(s, 'orders')], sizeOf: size });
    writeSchema(doc, s);

    const { areas: _areas, ...withoutAreas } = cloneSchema(s);
    withoutAreas.tables[0].logicalName = '회원';
    writeSchema(doc, withoutAreas);
    expect(readSchema(doc).areas).toHaveLength(1);
    expect(readSchema(doc).tables[0].logicalName).toBe('회원');

    writeSchema(doc, { ...s, areas: [] });
    expect(readSchema(doc).areas).toBeUndefined();
  });

  it('두 사람이 다른 영역을 동시에 고쳐도 둘 다 남는다', () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    const s = shop();
    createArea(s, { name: 'A', tableIds: [id(s, 'member')], sizeOf: size });
    createArea(s, { name: 'B', tableIds: [id(s, 'product')], sizeOf: size });
    writeSchema(a, s);
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

    const sa = readSchema(a);
    sa.areas![0].name = 'A2';
    writeSchema(a, sa);
    const sb = readSchema(b);
    sb.areas![1].collapsed = true;
    writeSchema(b, sb);
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    expect(readSchema(a).areas).toEqual(readSchema(b).areas);
    expect(readSchema(a).areas!.map((x) => [x.name, Boolean(x.collapsed)])).toEqual(
      expect.arrayContaining([['A2', false], ['B', true]]),
    );
  });
});

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
