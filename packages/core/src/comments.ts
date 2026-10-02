// 테이블·컬럼 댓글. ERD 구조(스키마)와 따로 문서의 'comments' 맵에 둔다.
// 그래서 SQL·비교·버전·되돌리기(Ctrl+Z)에는 영향이 없고, 실시간으로 같이 보인다.

import * as Y from 'yjs';
import { newId } from './model';

export type CommentKind = 'comment' | 'review';

export interface CommentAuthor {
  id?: string;
  name: string;
}

export interface CommentReply {
  id: string;
  author: CommentAuthor;
  text: string;
  createdAt: string;
}

export interface CommentThread {
  id: string;
  /** 어느 테이블(과 컬럼)에 단 댓글인지 */
  tableId: string;
  columnId?: string;
  /** review = 확인 요청 */
  kind: CommentKind;
  status: 'open' | 'resolved';
  author: CommentAuthor;
  text: string;
  createdAt: string;
  resolvedBy?: CommentAuthor;
  resolvedAt?: string;
  replies: CommentReply[];
}

function commentsMap(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap('comments') as Y.Map<Y.Map<unknown>>;
}

export function readComments(doc: Y.Doc): CommentThread[] {
  const threads: CommentThread[] = [];
  commentsMap(doc).forEach((map, id) => {
    const replies = map.get('replies') as Y.Array<CommentReply> | undefined;
    threads.push({
      id,
      tableId: map.get('tableId') as string,
      columnId: (map.get('columnId') as string | undefined) || undefined,
      kind: (map.get('kind') as CommentKind) ?? 'comment',
      status: (map.get('status') as CommentThread['status']) ?? 'open',
      author: map.get('author') as CommentAuthor,
      text: (map.get('text') as string) ?? '',
      createdAt: (map.get('createdAt') as string) ?? '',
      resolvedBy: map.get('resolvedBy') as CommentAuthor | undefined,
      resolvedAt: map.get('resolvedAt') as string | undefined,
      replies: replies ? replies.toArray().map((r) => ({ ...r })) : [],
    });
  });
  return threads.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function addComment(doc: Y.Doc, input: { tableId: string; columnId?: string; kind?: CommentKind; author: CommentAuthor; text: string }): string {
  const text = input.text.trim();
  if (!text) throw new Error('댓글 내용을 입력하세요');
  const id = newId('cmt');
  const map = new Y.Map<unknown>();
  map.set('tableId', input.tableId);
  if (input.columnId) map.set('columnId', input.columnId);
  map.set('kind', input.kind ?? 'comment');
  map.set('status', 'open');
  map.set('author', input.author);
  map.set('text', text.slice(0, 4000));
  map.set('createdAt', new Date().toISOString());
  map.set('replies', new Y.Array<CommentReply>());
  commentsMap(doc).set(id, map);
  return id;
}

/** 답글은 배열 끝에 붙이므로 두 사람이 동시에 달아도 둘 다 남는다 */
export function replyComment(doc: Y.Doc, threadId: string, author: CommentAuthor, text: string): void {
  const map = commentsMap(doc).get(threadId);
  if (!map) throw new Error('댓글을 찾을 수 없습니다');
  const body = text.trim();
  if (!body) throw new Error('답글 내용을 입력하세요');
  let replies = map.get('replies') as Y.Array<CommentReply> | undefined;
  if (!replies) {
    replies = new Y.Array<CommentReply>();
    map.set('replies', replies);
  }
  replies.push([{ id: newId('rpl'), author, text: body.slice(0, 4000), createdAt: new Date().toISOString() }]);
}

export function setCommentStatus(doc: Y.Doc, threadId: string, status: CommentThread['status'], by: CommentAuthor): void {
  const map = commentsMap(doc).get(threadId);
  if (!map) return;
  map.set('status', status);
  if (status === 'resolved') {
    map.set('resolvedBy', by);
    map.set('resolvedAt', new Date().toISOString());
  } else {
    map.delete('resolvedBy');
    map.delete('resolvedAt');
  }
}

export function deleteComment(doc: Y.Doc, threadId: string): void {
  commentsMap(doc).delete(threadId);
}

/** 지워진 테이블·컬럼에 달린 댓글 (화면에서 "대상 없음"으로 보여준다) */
export function orphanComments(threads: CommentThread[], schema: { tables: { id: string; columns: { id: string }[] }[] }): Set<string> {
  const orphans = new Set<string>();
  for (const t of threads) {
    const table = schema.tables.find((x) => x.id === t.tableId);
    if (!table || (t.columnId && !table.columns.some((c) => c.id === t.columnId))) orphans.add(t.id);
  }
  return orphans;
}
