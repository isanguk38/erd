import { useEffect, useMemo, useRef, useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import { useStore } from '../store';
import { searchSchema, type SearchResult } from '../lib/search';
import { Icon } from './ui';

/** 검색어에 맞는 부분을 굵게 */
function Highlight({ text, query }: { text: string; query: string }) {
  const q = query.trim().toLowerCase();
  const i = q ? text.toLowerCase().indexOf(q) : -1;
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}

/** Ctrl+F: 테이블·컬럼 빨리 찾기. 결과를 고르면 그 테이블로 이동해 강조한다. */
export function SearchBox() {
  const open = useStore((s) => s.searchOpen);
  const query = useStore((s) => s.searchQuery);
  const schema = useStore((s) => s.schema);
  const { setSearchOpen, setSearchQuery, setSearchFocus, select } = useStore.getState();
  const { fitView } = useReactFlow();
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const results = useMemo(() => searchSchema(schema, query), [schema, query]);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.select(), 0);
  }, [open]);
  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!open) return null;

  const go = (r: SearchResult | undefined) => {
    if (!r) return;
    select({ type: 'table', id: r.tableId }, true);
    setSearchFocus({ tableId: r.tableId, columnId: r.columnId });
    fitView({ nodes: [{ id: r.tableId }], padding: 0.8, duration: 350, maxZoom: 1.3 });
    // 고르면 창만 닫는다. 검색어는 남겨 두어 다시 열면 이어서 찾는다 (열 때 검색어 전체가 선택돼 바로 새로 입력할 수도 있다)
    setSearchOpen(false, true);
  };

  const tableCount = new Set(results.map((r) => r.tableId)).size;

  return (
    <div className="search-box" role="dialog" aria-label="테이블·컬럼 검색">
      <div className="search-box__input">
        <Icon name="search" />
        <input
          ref={inputRef}
          value={query}
          placeholder="테이블·컬럼 이름, 논리명, 설명으로 찾기"
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, results.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              go(results[active]);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              setSearchOpen(false);
            }
          }}
        />
        {query && <span className="search-box__count">{results.length ? `${results.length}건 · 테이블 ${tableCount}개` : '없음'}</span>}
        <button className="icon-btn" onClick={() => setSearchOpen(false)} title="닫기 (Esc)">
          <Icon name="close" size={14} />
        </button>
      </div>
      {query && (
        <ul className="search-box__results" ref={listRef}>
          {results.length === 0 && <li className="search-box__empty">"{query}"에 맞는 테이블·컬럼이 없습니다.</li>}
          {results.map((r, i) => (
            <li key={`${r.tableId}:${r.columnId ?? ''}`}>
              <button className={i === active ? 'active' : ''} onMouseEnter={() => setActive(i)} onClick={() => go(r)}>
                <span className={`search-kind search-kind-${r.kind}`}>{r.kind === 'table' ? '테이블' : '컬럼'}</span>
                <span className="search-title">
                  <Highlight text={r.title} query={query} />
                </span>
                <span className="search-detail">
                  <Highlight text={r.detail} query={query} />
                </span>
                {r.matchedIn !== '물리명' && <span className="search-where">{r.matchedIn}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="search-box__help">
        <kbd>↑</kbd><kbd>↓</kbd> 이동 · <kbd>Enter</kbd> 그 테이블로 가기 · <kbd>Esc</kbd> 닫기 · 일치하는 테이블·컬럼은 캔버스에도 표시됩니다
      </div>
    </div>
  );
}
