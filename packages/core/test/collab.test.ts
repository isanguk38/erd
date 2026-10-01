import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { applyCommands, CommandError, describeSchema, emptySchema, readSchema, writeSchema, type Schema } from '../src';

function shop(): Schema {
  return applyCommands(emptySchema(), [
    {
      op: 'createTable', name: 'member', logicalName: '회원',
      columns: [
        { name: 'member_id', type: 'BIGINT', primaryKey: true, autoIncrement: true },
        { name: 'email', type: 'VARCHAR(100)', nullable: false, unique: true },
      ],
    },
    { op: 'createTable', name: 'orders', columns: [{ name: 'order_id', type: 'BIGINT', primaryKey: true }] },
    { op: 'addRelation', parent: 'member', child: 'orders' },
    { op: 'addIndex', table: 'orders', columns: ['member_id'] },
  ]).schema;
}

describe('편집 명령', () => {
  it('이름으로 테이블·컬럼·관계·인덱스를 만든다', () => {
    const summary = describeSchema(shop());
    expect(summary.tables[0].columns[1]).toMatchObject({ name: 'email', type: 'VARCHAR(100)', nullable: false, unique: true });
    expect(summary.tables[1].columns.map((c) => c.name)).toEqual(['order_id', 'member_id']);
    expect(summary.tables[1].indexes).toEqual([{ name: undefined, unique: false, columns: ['member_id'] }]);
    expect(summary.relations[0]).toMatchObject({ parent: 'member', child: 'orders', childColumns: ['member_id'] });
  });

  it('하나라도 실패하면 아무것도 바뀌지 않고 이유를 알려준다', () => {
    const base = shop();
    expect(() => applyCommands(base, [
      { op: 'addColumn', table: 'member', column: { name: 'nickname', type: 'VARCHAR(30)' } },
      { op: 'dropColumn', table: 'member', column: 'nope' },
    ])).toThrow(CommandError);
    expect(() => applyCommands(base, [{ op: 'dropColumn', table: 'member', column: 'nope' }])).toThrow('있는 컬럼: member_id, email');
    expect(base.tables[0].columns).toHaveLength(2);
  });

  it('N:M은 연결 테이블을 만든다', () => {
    const { schema, messages } = applyCommands(shop(), [
      { op: 'createTable', name: 'product', columns: [{ name: 'product_id', type: 'BIGINT', primaryKey: true }] },
      { op: 'addRelation', parent: 'orders', child: 'product', cardinality: 'N:M' },
    ]);
    expect(messages[1]).toContain('연결 테이블 orders_product');
    const junction = schema.tables.find((t) => t.name === 'orders_product')!;
    expect(junction.columns.filter((c) => c.primaryKey).map((c) => c.name)).toEqual(['order_id', 'product_id']);
  });
});

describe('Yjs 문서', () => {
  it('스키마를 쓰고 읽으면 같다', () => {
    const doc = new Y.Doc();
    const schema = shop();
    writeSchema(doc, schema);
    expect(readSchema(doc)).toEqual(schema);
  });

  it('두 사람이 같은 테이블의 다른 컬럼을 동시에 고쳐도 둘 다 남는다', () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    writeSchema(a, shop());
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

    // A: email 길이 변경, B: 같은 테이블에 컬럼 추가 (서로 모르는 상태)
    const sa = readSchema(a);
    sa.tables[0].columns[1].length = '200';
    writeSchema(a, sa);
    const sb = readSchema(b);
    sb.tables[0].columns.push({ ...sb.tables[0].columns[1], id: 'col_nick', name: 'nickname', unique: false });
    writeSchema(b, sb);

    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    const merged = readSchema(a);
    expect(merged).toEqual(readSchema(b));
    expect(merged.tables[0].columns.map((c) => `${c.name}:${c.length}`)).toEqual(['member_id:', 'email:200', 'nickname:100']);
  });

  it('바뀐 필드만 기록한다', () => {
    const doc = new Y.Doc();
    writeSchema(doc, shop());
    let updates = 0;
    doc.on('update', () => updates++);
    writeSchema(doc, readSchema(doc));
    expect(updates).toBe(0);
  });
});
