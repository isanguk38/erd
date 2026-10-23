// 새 소식: 공지·주의사항, 웹 업데이트, 앱 업데이트. 관리자 페이지에서 쓴 글 중 게시한 것.
// 메인(프로젝트 목록) 옆에는 제목·첫 줄만 보이고 누르면 넓은 읽기 창으로, 편집 화면에서는 새 글이 있으면 아래에 잠깐 알리고 창으로 본다.
// 읽음 여부는 이 기기·브라우저에 기억한다 (처음 보는 글에 NEW).

import { useEffect, useMemo, useState } from 'react';
import { markNoticesSeen, NOTICE_KIND_LABEL, noticeApi, seenNotices, type NoticeItem } from '../lib/notices';
import { useStore } from '../store';
import { Modal } from './Modal';
import { markdownToHtml, NoteText } from './NoteText';
import { Icon } from './ui';

const date = (v?: string) => (v ? new Date(v).toLocaleDateString() : '');
const kindText = (n: NoticeItem) => (n.kind === 'app' && n.version ? `앱 ${n.version}` : NOTICE_KIND_LABEL[n.kind]);

function useNotices(limit: number) {
  const [list, setList] = useState<NoticeItem[] | null>(null);
  const [error, setError] = useState('');
  const [seen, setSeen] = useState(seenNotices);
  useEffect(() => {
    noticeApi.list(limit).then(setList).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [limit]);
  const onSeen = (ids: string[]) => {
    markNoticesSeen(ids);
    setSeen(seenNotices());
  };
  return { list, error, seen, onSeen };
}

/** 목록에 보일 첫 줄 (태그·마크다운 기호 없이) */
function excerpt(n: NoticeItem): string {
  const html = n.format === 'html' ? n.body : markdownToHtml(n.body);
  // 문단·칸 사이를 띄어 글자가 붙지 않게
  const spaced = html.replace(/<\/(p|h[1-6]|li|td|th|tr|div|blockquote|pre)>|<br\s*\/?>/gi, '$& ');
  const text = new DOMParser().parseFromString(spaced, 'text/html').body.textContent ?? '';
  return text.replace(/\s+/g, ' ').trim().slice(0, 120);
}

/** 글 목록 (눌러서 펼치면 읽음). onOpen이 있으면 펼치지 않고 읽기 창으로 */
function NoticeList({ list, compact, seen, onSeen, onOpen }: { list: NoticeItem[]; compact?: boolean; seen: Set<string>; onSeen: (ids: string[]) => void; onOpen?: (n: NoticeItem) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const toggle = (n: NoticeItem) => {
    if (onOpen) onOpen(n);
    else setOpen((cur) => (cur === n.id ? null : n.id));
    if (!seen.has(n.id)) onSeen([n.id]);
  };
  return (
    <ul className={`notice-list${compact ? ' compact' : ''}`}>
      {list.map((n) => (
        <li key={n.id} className={`notice-item kind-${n.kind}${n.pinned ? ' pinned' : ''}${open === n.id ? ' open' : ''}`}>
          <button className="notice-item__head" onClick={() => toggle(n)} aria-expanded={open === n.id}>
            <span className={`notice-kind kind-${n.kind}`}>{kindText(n)}</span>
            <span className="notice-item__title">{n.pinned && '📌 '}{n.title}</span>
            {!seen.has(n.id) && <span className="notice-new">NEW</span>}
            <span className="notice-item__date">{date(n.publishedAt)}</span>
            {onOpen && <ExcerptLine n={n} />}
            <span className="notice-item__chev" aria-hidden="true"><Icon name="chevron" size={14} /></span>
          </button>
          {open === n.id && <div className="notice-item__body"><NoteText text={n.body} format={n.format ?? 'markdown'} /></div>}
        </li>
      ))}
    </ul>
  );
}

function ExcerptLine({ n }: { n: NoticeItem }) {
  const text = useMemo(() => excerpt(n), [n]);
  return text ? <span className="notice-item__excerpt">{text}</span> : null;
}

/** 넓은 읽기 창: 표·코드도 좁지 않게, 이전·다음 글로 이어 읽기 */
function NoticeReader({ list, id, onPick, onClose }: { list: NoticeItem[]; id: string; onPick: (n: NoticeItem) => void; onClose: () => void }) {
  const i = list.findIndex((n) => n.id === id);
  const n = list[i];
  if (!n) return null;
  const prev = list[i - 1];
  const next = list[i + 1];
  return (
    <Modal
      title="새 소식"
      onClose={onClose}
      className="notice-reader-modal"
      footer={
        <div className="notice-reader__nav">
          <button className="btn btn-sm" disabled={!prev} onClick={() => prev && onPick(prev)} title={prev?.title}>‹ 이전 글</button>
          <span className="muted small">{i + 1} / {list.length}</span>
          <button className="btn btn-sm" disabled={!next} onClick={() => next && onPick(next)} title={next?.title}>다음 글 ›</button>
        </div>
      }
    >
      <article className={`notice-reader kind-${n.kind}`}>
        <div className="notice-reader__meta">
          <span className={`notice-kind kind-${n.kind}`}>{kindText(n)}</span>
          {n.pinned && <span className="muted small">📌 고정</span>}
          <span className="muted small">{date(n.publishedAt)}</span>
        </div>
        <h3 className="notice-reader__title">{n.title}</h3>
        <div className="notice-item__body notice-reader__body"><NoteText text={n.body} format={n.format ?? 'markdown'} /></div>
      </article>
    </Modal>
  );
}

/** 메인 화면의 "새 소식" (넓으면 오른쪽, 좁으면 위). 목록은 제목·첫 줄만, 누르면 읽기 창 */
export function NoticesPanel() {
  const { list, error, seen, onSeen } = useNotices(10);
  const [reading, setReading] = useState<string | null>(null);
  if (error) return null;
  const unseen = list?.filter((n) => !seen.has(n.id)).length ?? 0;
  return (
    <aside className="notices-panel" aria-label="새 소식">
      <div className="notices-panel__head">
        <span className="notices-panel__icon" aria-hidden="true"><Icon name="megaphone" size={15} /></span>
        <h2>새 소식</h2>
        {unseen > 0 && <span className="notices-panel__unseen">{unseen}</span>}
        {unseen > 0 && (
          <button className="btn btn-ghost btn-sm" onClick={() => onSeen(list!.map((n) => n.id))} title="모두 읽음으로 표시">
            모두 읽음
          </button>
        )}
      </div>
      {!list ? <p className="muted small">불러오는 중…</p> : list.length ? <NoticeList list={list} seen={seen} onSeen={onSeen} onOpen={(n) => setReading(n.id)} /> : <p className="muted small">아직 소식이 없습니다.</p>}
      {list && reading && (
        <NoticeReader
          list={list}
          id={reading}
          onPick={(n) => {
            setReading(n.id);
            if (!seen.has(n.id)) onSeen([n.id]);
          }}
          onClose={() => setReading(null)}
        />
      )}
    </aside>
  );
}

/** 편집 화면: 처음 보는 공지·웹 업데이트가 있으면 아래에 잠깐 알린다 (작업을 막지 않게, 들어올 때 한 번) */
export function useNoticeToast(onOpen: () => void) {
  useEffect(() => {
    let alive = true;
    noticeApi
      .list(10)
      .then((list) => {
        if (!alive) return;
        const seen = seenNotices();
        const fresh = list.filter((n) => n.kind !== 'app' && !seen.has(n.id));
        if (!fresh.length) return;
        useStore.getState().showNotice({ text: `새 소식${fresh.length > 1 ? ` ${fresh.length}개` : ''}: ${fresh[0]!.title}`, action: { label: '보기', run: onOpen } });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/** 편집 화면에서 여는 새 소식 창 */
export function NoticesDialog({ onClose }: { onClose: () => void }) {
  const { list, error, seen, onSeen } = useNotices(20);
  return (
    <Modal title="새 소식" onClose={onClose}>
      {error && <div className="error-box">{error}</div>}
      {!list ? <p className="muted">불러오는 중…</p> : list.length ? <NoticeList list={list} compact seen={seen} onSeen={onSeen} /> : <p className="muted">아직 소식이 없습니다.</p>}
    </Modal>
  );
}
