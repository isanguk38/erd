import { useCallback, useRef, useState } from 'react';
import type { DictTerm } from '@erd/core';
import { takeFocus } from '../lib/focus';

/** 타입 검사 결과를 편집 칸에 표시 (빨강: DB에서 실패, 주황: 주의) */
export interface Mark {
  className: string;
  title: string;
}

/** 입력 중에는 로컬 값만 바꾸고, 포커스를 잃거나 Enter를 누를 때 저장한다 (되돌리기 기록을 글자마다 남기지 않기 위해).
 * suggest를 주면 입력하는 동안 아래에 후보(표준 용어)를 보여 주고, 고르면 onPick (↑↓ Enter, 마우스)
 */
export function TextInput({ value, onCommit, placeholder, className, list, issue, focusKey, onEnter, suggest, onPick }: {
  value: string; onCommit: (v: string) => void; placeholder?: string; className?: string; list?: string; issue?: Mark; focusKey?: string; onEnter?: () => void;
  suggest?: (query: string) => DictTerm[]; onPick?: (term: DictTerm) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  // 고른 후보 (-1: 아직 안 고름 — Enter는 입력한 그대로 저장)
  const [active, setActive] = useState(-1);
  const [closed, setClosed] = useState(false);
  const inputEl = useRef<HTMLInputElement | null>(null);
  // 후보를 골랐으면 칸을 떠날 때 입력하던 글자를 저장하지 않는다 (고른 용어가 덮이지 않게)
  const picked = useRef(false);
  // 방금 만든 테이블·컬럼이면 이름 칸에 커서를 두고 전체 선택 (바로 타이핑해 이름을 바꾸게)
  const ref = useCallback((el: HTMLInputElement | null) => {
    inputEl.current = el;
    if (el && takeFocus(focusKey)) requestAnimationFrame(() => { el.focus(); el.select(); });
  }, [focusKey]);
  const commit = () => {
    if (picked.current) picked.current = false;
    else if (draft !== null && draft !== value) onCommit(draft);
    setDraft(null);
  };
  const items = suggest && draft !== null && !closed ? suggest(draft) : [];
  const pick = (term: DictTerm) => {
    picked.current = true;
    setDraft(null);
    onPick?.(term);
    inputEl.current?.blur();
  };
  const rect = items.length ? inputEl.current?.getBoundingClientRect() : undefined;
  return (
    <>
      <input
        ref={ref}
        className={[className, issue?.className].filter(Boolean).join(' ') || undefined}
        value={draft ?? value}
        // 칸이 좁아 잘려도 마우스를 올리면 전체 값이 보인다. 타입 문제가 있으면 그 이유도
        title={[issue?.title, draft ?? value].filter(Boolean).join('\n\n') || undefined}
        placeholder={placeholder}
        list={list}
        autoComplete="off"
        onChange={(e) => {
          setDraft(e.target.value);
          setActive(-1);
          setClosed(false);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (items.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault();
            setActive((a) => (a < 0 ? (e.key === 'ArrowDown' ? 0 : items.length - 1) : (a + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length));
            return;
          }
          if (items.length && active >= 0 && e.key === 'Enter') {
            e.preventDefault();
            pick(items[Math.min(active, items.length - 1)]);
            return;
          }
          if (e.key === 'Enter') {
            (e.target as HTMLInputElement).blur();
            onEnter?.();
          }
          if (e.key === 'Escape') {
            if (items.length) return setClosed(true);
            setDraft(null);
          }
        }}
      />
      {rect && (
        <ul className="term-suggest" style={{ left: rect.left, top: rect.bottom + 2, minWidth: Math.max(rect.width, 280) }} role="listbox">
          {items.map((t, i) => (
            <li
              key={t.logical}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'active' : ''}
              // 누르는 순간 입력 칸이 포커스를 잃지 않게 (그래야 고른 용어가 들어간다)
              onMouseDown={(e) => {
                e.preventDefault();
                pick(t);
              }}
              onMouseEnter={() => setActive(i)}
            >
              <b className="mono">{t.physical}</b>
              <span>{t.logical}</span>
              <span className="muted mono">{t.type ? `${t.type}${t.length ? `(${t.length})` : ''}` : ''}</span>
            </li>
          ))}
          <li className="term-suggest__hint muted">표준 용어 사전 · 누르거나 ↑↓ 후 Enter로 고르기 · 그냥 Enter는 입력한 그대로 · Esc 닫기</li>
        </ul>
      )}
    </>
  );
}

