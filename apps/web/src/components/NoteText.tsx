import type { ReactNode } from 'react';

/**
 * 간단한 마크다운(## 제목, - 목록, **굵게**, `코드`)을 보여 준다. HTML은 넣지 않는다 (글자 그대로).
 * 앱 업데이트 안내·공지사항·관리자 페이지 미리보기에서 함께 쓴다.
 */
export function NoteText({ text, empty = '내용이 없습니다.' }: { text: string; empty?: string }) {
  const blocks: ReactNode[] = [];
  let items: ReactNode[] = [];
  const flush = () => {
    if (items.length) blocks.push(<ul key={blocks.length}>{items.map((t, i) => <li key={i}>{t}</li>)}</ul>);
    items = [];
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^[-*]\s+/.test(line)) {
      items.push(inline(line.replace(/^[-*]\s+/, '')));
      continue;
    }
    flush();
    if (/^#{1,6}\s+/.test(line)) blocks.push(<h4 key={blocks.length}>{inline(line.replace(/^#{1,6}\s+/, ''))}</h4>);
    else if (line) blocks.push(<p key={blocks.length}>{inline(line)}</p>);
  }
  flush();
  return <div className="release-notes">{blocks.length ? blocks : <p className="muted">{empty}</p>}</div>;
}

/** **굵게**, `코드` */
function inline(text: string): ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
  return parts.map((p, i) =>
    p.startsWith('**') && p.endsWith('**') ? <b key={i}>{p.slice(2, -2)}</b> : p.startsWith('`') && p.endsWith('`') ? <code key={i}>{p.slice(1, -1)}</code> : <span key={i}>{p}</span>,
  );
}
