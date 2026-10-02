import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  addComment,
  applyCommands,
  changedTables,
  cloneSchema,
  deleteComment,
  emptySchema,
  orphanComments,
  readComments,
  readSchema,
  removeTable,
  replyComment,
  setCommentStatus,
  writeSchema,
} from '../src';

const me = { id: 'u1', name: '상욱' };
const friend = { id: 'u2', name: '친구' };

function shop() {
  return applyCommands(emptySchema(), [
    { op: 'createTable', name: 'member', columns: [{ name: 'member_id', type: 'BIGINT', primaryKey: true }, { name: 'email', type: 'VARCHAR(100)' }] },
    { op: 'createTable', name: 'orders', columns: [{ name: 'order_id', type: 'BIGINT', primaryKey: true }] },
  ]).schema;
}

describe('댓글', () => {
  it('댓글·확인 요청을 달고, 답글·해결·다시 열기·삭제', () => {
    const doc = new Y.Doc();
    const s = shop();
    writeSchema(doc, s);
    const member = s.tables[0];
    const a = addComment(doc, { tableId: member.id, author: me, text: '  회원 탈퇴 컬럼 필요?  ' });
    const b = addComment(doc, { tableId: member.id, columnId: member.columns[1].id, kind: 'review', author: me, text: 'email 길이 확인 부탁' });
    expect(() => addComment(doc, { tableId: member.id, author: me, text: '   ' })).toThrow();

    replyComment(doc, b, friend, '200으로 늘릴게요');
    setCommentStatus(doc, b, 'resolved', friend);
    let list = readComments(doc);
    expect(list.map((t) => [t.text, t.kind, t.status])).toEqual([
      ['회원 탈퇴 컬럼 필요?', 'comment', 'open'],
      ['email 길이 확인 부탁', 'review', 'resolved'],
    ]);
    expect(list[1]).toMatchObject({ columnId: member.columns[1].id, resolvedBy: friend, replies: [{ author: friend, text: '200으로 늘릴게요' }] });

    setCommentStatus(doc, b, 'open', me);
    expect(readComments(doc)[1].resolvedBy).toBeUndefined();
    deleteComment(doc, a);
    list = readComments(doc);
    expect(list.map((t) => t.id)).toEqual([b]);
  });

  it('댓글은 ERD 구조와 따로라 스키마·SQL에 영향이 없다', () => {
    const doc = new Y.Doc();
    const s = shop();
    writeSchema(doc, s);
    const before = JSON.stringify(readSchema(doc));
    addComment(doc, { tableId: s.tables[0].id, author: me, text: '메모' });
    expect(JSON.stringify(readSchema(doc))).toBe(before);
  });

  it('두 사람이 동시에 답글을 달면 둘 다 남는다', () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    const s = shop();
    writeSchema(a, s);
    const id = addComment(a, { tableId: s.tables[0].id, author: me, text: '질문' });
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    replyComment(a, id, me, '답 A');
    replyComment(b, id, friend, '답 B');
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    expect(readComments(a)[0].replies.map((r) => r.text).sort()).toEqual(['답 A', '답 B']);
    expect(readComments(a)).toEqual(readComments(b));
  });

  it('테이블·컬럼이 지워지면 그 댓글을 "대상 없음"으로 알 수 있다', () => {
    const doc = new Y.Doc();
    const s = shop();
    writeSchema(doc, s);
    const t = addComment(doc, { tableId: s.tables[1].id, author: me, text: 'orders' });
    const c = addComment(doc, { tableId: s.tables[0].id, columnId: s.tables[0].columns[1].id, author: me, text: 'email' });
    const next = cloneSchema(s);
    removeTable(next, s.tables[1].id);
    next.tables[0].columns.pop();
    expect([...orphanComments(readComments(doc), next)].sort()).toEqual([t, c].sort());
    expect(orphanComments(readComments(doc), s).size).toBe(0);
  });
});

describe('바뀐 곳 찾기 (변경 강조)', () => {
  it('새 테이블, 바뀐·새 컬럼, 관계가 생긴 자식 테이블. 위치만 바뀐 것은 제외', () => {
    const before = shop();
    const after = applyCommands(before, [
      { op: 'createTable', name: 'coupon', columns: [{ name: 'coupon_id', type: 'BIGINT', primaryKey: true }] },
      { op: 'updateColumn', table: 'member', column: 'email', changes: { type: 'VARCHAR(200)' } },
      { op: 'addRelation', parent: 'member', child: 'orders' },
    ]).schema;
    after.tables[0].position = { x: 999, y: 999 };
    const changes = changedTables(before, after);
    const byName = (n: string) => changes.get(after.tables.find((t) => t.name === n)!.id);
    expect(byName('coupon')).toMatchObject({ added: true });
    expect(byName('member')!.columnIds).toEqual([after.tables[0].columns[1].id]);
    expect(byName('orders')!.columnIds).toHaveLength(1); // 새 FK 컬럼

    const moved = cloneSchema(before);
    moved.tables[1].position = { x: 5, y: 5 };
    expect(changedTables(before, moved).size).toBe(0);
  });

  it('컬럼을 지우거나 순서만 바꿔도 그 테이블을 표시한다', () => {
    const before = shop();
    const removed = cloneSchema(before);
    removed.tables[0].columns.pop();
    expect(changedTables(before, removed).has(before.tables[0].id)).toBe(true);
    const reordered = cloneSchema(before);
    reordered.tables[0].columns.reverse();
    expect(changedTables(before, reordered).has(before.tables[0].id)).toBe(true);
  });
});
