import { useMemo, useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import { orphanComments, type CommentKind, type CommentThread, type Table } from '@erd/core';
import { useStore } from '../store';
import { Icon } from './ui';

const ago = (iso: string) => {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return '방금';
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  return new Date(iso).toLocaleDateString();
};

function Thread({ thread, table, showTarget, onGo }: { thread: CommentThread; table?: Table; showTarget?: boolean; onGo?: () => void }) {
  const { replyComment, setCommentStatus, deleteComment } = useStore.getState();
  const canEdit = useStore((s) => s.role !== 'viewer' && !s.compare);
  const me = useStore((s) => s.me);
  const [reply, setReply] = useState('');
  const column = thread.columnId ? table?.columns.find((c) => c.id === thread.columnId) : null;
  const mine = me?.user ? thread.author.id === me.user.id : true;
  return (
    <div className={`comment-thread${thread.status === 'resolved' ? ' resolved' : ''}${thread.kind === 'review' ? ' review' : ''}`}>
      <div className="comment-thread__meta">
        {thread.kind === 'review' && <span className="comment-tag">확인 요청</span>}
        {showTarget && (
          <button className="comment-target" onClick={onGo} title="그 테이블로 이동">
            {table ? `${table.name}${column ? `.${column.name}` : ''}` : '(지워진 테이블)'}
          </button>
        )}
        {!showTarget && column && <span className="comment-target-static">{column.name}</span>}
        <b>{thread.author.name}</b>
        <span className="muted">{ago(thread.createdAt)}</span>
      </div>
      <p className="comment-text">{thread.text}</p>
      {thread.replies.map((r) => (
        <div key={r.id} className="comment-reply">
          <b>{r.author.name}</b> <span className="muted">{ago(r.createdAt)}</span>
          <p className="comment-text">{r.text}</p>
        </div>
      ))}
      {thread.status === 'resolved' && thread.resolvedBy && (
        <div className="muted small">✓ {thread.resolvedBy.name}님이 {thread.kind === 'review' ? '확인' : '해결'}했습니다</div>
      )}
      {canEdit && (
        <div className="comment-actions">
          {thread.status === 'open' && (
            <input
              className="comment-reply-input"
              value={reply}
              placeholder="답글 (Enter)"
              onChange={(e) => setReply(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && reply.trim()) {
                  replyComment(thread.id, reply);
                  setReply('');
                }
              }}
            />
          )}
          <button className="btn btn-ghost small" onClick={() => setCommentStatus(thread.id, thread.status === 'open' ? 'resolved' : 'open')}>
            {thread.status === 'open' ? (thread.kind === 'review' ? '확인 완료' : '해결') : '다시 열기'}
          </button>
          {mine && (
            <button className="btn btn-ghost small btn-danger-text" onClick={() => confirm('이 댓글을 지울까요?') && deleteComment(thread.id)}>
              삭제
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** 오른쪽 패널: 고른 테이블의 댓글 */
export function TableComments({ table }: { table: Table }) {
  const comments = useStore((s) => s.comments);
  const canEdit = useStore((s) => s.role !== 'viewer' && !s.compare);
  const addComment = useStore((s) => s.addComment);
  const [text, setText] = useState('');
  const [columnId, setColumnId] = useState('');
  const [kind, setKind] = useState<CommentKind>('comment');
  const [showResolved, setShowResolved] = useState(false);
  const threads = comments.filter((c) => c.tableId === table.id);
  const visible = threads.filter((c) => showResolved || c.status === 'open');
  const resolved = threads.length - threads.filter((c) => c.status === 'open').length;

  const submit = () => {
    if (!text.trim()) return;
    addComment({ tableId: table.id, columnId: columnId || undefined, kind, text });
    setText('');
  };

  return (
    <div className="inspector__section comments-section">
      <div className="inspector__section-head">
        <h4>댓글 {threads.length - resolved > 0 && <span className="muted">{threads.length - resolved}</span>}</h4>
        {resolved > 0 && (
          <button className="btn btn-ghost small" onClick={() => setShowResolved(!showResolved)}>
            {showResolved ? '해결된 것 숨기기' : `해결된 것 ${resolved}개 보기`}
          </button>
        )}
      </div>
      {visible.map((t) => <Thread key={t.id} thread={t} table={table} />)}
      {canEdit ? (
        <div className="comment-new">
          <textarea value={text} placeholder="이 테이블에 댓글 남기기 (Ctrl+Enter)" rows={2} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && submit()} />
          <div className="comment-new__row">
            <select value={columnId} onChange={(e) => setColumnId(e.target.value)} title="어느 컬럼에 대한 댓글인지">
              <option value="">테이블 전체</option>
              {table.columns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <label className="comment-kind" title="확인 요청은 위쪽 댓글 목록과 테이블에 따로 표시됩니다">
              <input type="checkbox" checked={kind === 'review'} onChange={(e) => setKind(e.target.checked ? 'review' : 'comment')} /> 확인 요청
            </label>
            <button className="btn btn-primary small" disabled={!text.trim()} onClick={submit}>남기기</button>
          </div>
        </div>
      ) : (
        <p className="muted small">보기 권한에서는 댓글을 남길 수 없습니다.</p>
      )}
    </div>
  );
}

/** 위쪽 '댓글' 버튼: 프로젝트 전체 댓글 */
export function CommentsPanel({ onClose }: { onClose: () => void }) {
  const comments = useStore((s) => s.comments);
  const schema = useStore((s) => s.schema);
  const { fitView } = useReactFlow();
  const [filter, setFilter] = useState<'open' | 'review' | 'all'>('open');
  const orphans = useMemo(() => orphanComments(comments, schema), [comments, schema]);
  const list = comments
    .filter((c) => (filter === 'all' ? true : filter === 'review' ? c.kind === 'review' && c.status === 'open' : c.status === 'open'))
    .slice()
    .reverse();
  const go = (c: CommentThread) => {
    if (orphans.has(c.id) && !schema.tables.some((t) => t.id === c.tableId)) return;
    const { select, setSearchFocus } = useStore.getState();
    select({ type: 'table', id: c.tableId }, true);
    setSearchFocus({ tableId: c.tableId, columnId: c.columnId });
    // 지금 주제영역 탭에 없는 테이블이면 그 테이블이 있는 영역(없으면 전체)으로 바꾼 뒤 보여 준다
    const switched = useStore.getState().revealTable(c.tableId);
    setTimeout(() => fitView({ nodes: [{ id: c.tableId }], padding: 0.8, duration: 350, maxZoom: 1.3 }), switched ? 120 : 0);
  };
  const count = (f: typeof filter) => comments.filter((c) => (f === 'all' ? true : f === 'review' ? c.kind === 'review' && c.status === 'open' : c.status === 'open')).length;

  return (
    <div className="lint-panel comments-panel" role="dialog" aria-label="댓글">
      <div className="lint-panel__head">
        <h3>댓글</h3>
        <div className="segmented small-seg">
          {(['open', 'review', 'all'] as const).map((f) => (
            <button key={f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>
              {{ open: '열림', review: '확인 요청', all: '전체' }[f]} {count(f)}
            </button>
          ))}
        </div>
        <button className="icon-btn" onClick={onClose} title="닫기"><Icon name="close" size={14} /></button>
      </div>
      <div className="lint-groups">
        {list.length === 0 ? (
          <p className="muted" style={{ padding: 16 }}>
            {filter === 'all' ? '아직 댓글이 없습니다. 테이블을 고르면 오른쪽 패널에서 댓글을 남길 수 있습니다.' : '열린 댓글이 없습니다.'}
          </p>
        ) : (
          list.map((c) => <Thread key={c.id} thread={c} table={schema.tables.find((t) => t.id === c.tableId)} showTarget onGo={() => go(c)} />)
        )}
      </div>
    </div>
  );
}

/** 열린 댓글 수 (위쪽 버튼 배지) */
export function useOpenCommentCount(): number {
  return useStore((s) => s.comments.filter((c) => c.status === 'open').length);
}
