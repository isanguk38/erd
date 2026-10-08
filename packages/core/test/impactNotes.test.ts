import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  addNote,
  applyCommands,
  changeImpact,
  columnDeleteImpact,
  emptySchema,
  lintSchema,
  notesOf,
  propagateColumnType,
  readNotes,
  readSchema,
  removeNote,
  tableDeleteImpact,
  typeMismatches,
  updateNote,
  writeSchema,
} from '../src';

describe('영향도 분석', () => {
  const { schema } = applyCommands(emptySchema(), [
    { op: 'createTable', name: 'member', columns: [{ name: 'id', type: 'BIGINT', primaryKey: true }, { name: 'email', type: 'VARCHAR(100)' }, { name: 'point', type: 'INT' }] },
    { op: 'createTable', name: 'orders', columns: [{ name: 'id', type: 'BIGINT', primaryKey: true }] },
    { op: 'createTable', name: 'review', columns: [{ name: 'id', type: 'BIGINT', primaryKey: true }] },
    { op: 'addRelation', parent: 'member', child: 'orders' },
    { op: 'addRelation', parent: 'orders', child: 'review', identifying: true },
    { op: 'addIndex', table: 'member', columns: ['email', 'point'] },
    { op: 'addCheck', table: 'member', expression: 'point >= 0' },
    { op: 'createArea', name: '회원', tables: ['member'] },
  ]);
  const member = schema.tables.find((t) => t.name === 'member')!;
  const col = (n: string) => member.columns.find((c) => c.name === n)!.id;

  it('컬럼 삭제: 다른 테이블 외래키, 인덱스 축소, CHECK', () => {
    const pk = columnDeleteImpact(schema, member.id, col('id'));
    expect(pk.filter((i) => i.external).map((i) => i.text)[0]).toContain('orders(member_id) → member.id');
    const point = columnDeleteImpact(schema, member.id, col('point'));
    expect(point.map((i) => i.kind).sort()).toEqual(['check', 'index']);
    expect(point.find((i) => i.kind === 'index')?.text).toContain('→ (email)');
  });

  it('테이블 삭제: 자식 외래키와 영역', () => {
    const items = tableDeleteImpact(schema, member.id);
    expect(items.filter((i) => i.external)).toHaveLength(1);
    expect(items.some((i) => i.kind === 'area' && i.text.includes('회원'))).toBe(true);
  });

  it('타입 변경: FK로 이어진 컬럼(손자까지)을 찾아 맞춘다', () => {
    const s = structuredClone(schema);
    const m = s.tables.find((t) => t.name === 'member')!;
    m.columns.find((c) => c.name === 'id')!.type = 'VARCHAR';
    m.columns.find((c) => c.name === 'id')!.length = '20';
    // orders.id → review.orders_id 는 member.id와 이어지지 않는다 (다른 컬럼)
    expect(typeMismatches(s, m.id, col('id')).map((l) => `${l.table}.${l.column}`)).toEqual(['orders.member_id']);
    expect(changeImpact(schema, s)[0]).toContain('orders.member_id(BIGINT)');
    expect(propagateColumnType(s, m.id, col('id'))).toEqual(['orders.member_id']);
    expect(typeMismatches(s, m.id, col('id'))).toEqual([]);
    expect(lintSchema(s, 'mysql').some((i) => i.rule === 'fk-type-mismatch')).toBe(false);
  });

  it('AI 편집 결과: 지운 PK 컬럼 때문에 사라진 외래키를 알린다', () => {
    const { schema: after } = applyCommands(schema, [{ op: 'dropColumn', table: 'member', column: 'id' }]);
    expect(changeImpact(schema, after).join('\n')).toContain('member.id 삭제');
  });
});

describe('캔버스 메모', () => {
  it('스키마와 따로 저장되고, 탭별로 나뉘고, 지운 영역의 메모는 숨긴다', () => {
    const doc = new Y.Doc();
    const { schema } = applyCommands(emptySchema(), [{ op: 'createTable', name: 'a' }, { op: 'createArea', name: '회원', tables: ['a'] }]);
    writeSchema(doc, schema);
    const areaId = schema.areas![0].id;
    const all = addNote(doc, { text: '전체 메모', position: { x: 10.4, y: 20 } });
    const inArea = addNote(doc, { text: '영역 메모', position: { x: 0, y: 0 }, areaId });
    expect(readSchema(doc)).toEqual(readSchema(doc)); // 스키마에는 notes가 없다
    expect('notes' in readSchema(doc)).toBe(false);
    expect(notesOf(readNotes(doc), null).map((n) => n.id)).toEqual([all]);
    expect(notesOf(readNotes(doc), areaId).map((n) => n.id)).toEqual([inArea]);
    expect(readNotes(doc).find((n) => n.id === all)?.position).toEqual({ x: 10, y: 20 });
    updateNote(doc, all, { text: '고침', width: 10, color: '#dbeafe' });
    expect(readNotes(doc).find((n) => n.id === all)).toMatchObject({ text: '고침', width: 120, color: '#dbeafe' });
    writeSchema(doc, { ...readSchema(doc), areas: [] });
    expect(readNotes(doc).map((n) => n.id)).toEqual([all]);
    removeNote(doc, all);
    expect(readNotes(doc)).toEqual([]);
  });
});
