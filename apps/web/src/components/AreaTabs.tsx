import { useCallback, useEffect, useRef, useState } from 'react';
import { createArea, removeArea, updateArea } from '@erd/core';
import { ColorPicker } from './ColorPicker';
import { selectAreas, useStore } from '../store';
import { Icon } from './ui';

/**
 * 주제영역 탭: [전체] [주문] [회원] … [+ 영역] [≡ 목록]
 * 탭을 누르면 그 영역 테이블만 보인다. 테이블을 꾹 누른 채 끌어 탭에 놓으면 그 영역으로 옮긴다 (Canvas가 처리, data-area-tab).
 * 고른 영역의 ⋯ 메뉴: 이름 바꾸기·색·영역 지우기 (테이블은 남음). 탭을 더블클릭해도 이름을 바꾼다.
 *
 * 영역이 많아 한 줄에 다 안 들어가면: 탭 줄만 가로로 넘기고(마우스 휠·‹ › 버튼, 끝은 흐리게),
 * 오른쪽 "영역 목록"에서 검색해 바로 고른다. 고른 탭은 늘 보이게 스크롤한다.
 * 꾹 눌러 옮기는 중에 ‹ › 위에 올려 두면 탭 줄이 넘어가 가려진 탭에도 놓을 수 있다.
 */
export function AreaTabs() {
  const areas = useStore(selectAreas);
  const tableCount = useStore((s) => s.schema.tables.length);
  const activeArea = useStore((s) => s.activeArea);
  const role = useStore((s) => s.role);
  const synced = useStore((s) => s.synced);
  const readOnly = role === 'viewer';
  const { edit, setActiveArea } = useStore.getState();
  const [renaming, setRenaming] = useState<string | null>(null);
  // 영역 메뉴: 탭 줄은 가로로 넘치면 잘리므로 화면 기준 위치에 띄운다
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const active = areas.find((a) => a.id === activeArea) ?? null;

  // 지워진 영역을 보고 있었으면 전체로
  useEffect(() => {
    if (synced && activeArea && !active) setActiveArea(null);
  }, [synced, activeArea, active, setActiveArea]);
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => !menuRef.current?.contains(e.target as Node) && setMenu(null);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setMenu(null);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [menu]);

  // ── 넘칠 때: 가로 스크롤 ─────────────────────────────
  const scroller = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const updateEdges = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const left = el.scrollLeft > 2;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
    setEdges((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
  }, []);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    updateEdges();
    const ro = new ResizeObserver(updateEdges);
    ro.observe(el);
    return () => ro.disconnect();
  }, [updateEdges, areas.length]);
  // 고른 탭이 가려져 있으면 보이게 (검색·참조 카드·목록으로 영역이 바뀐 경우도)
  useEffect(() => {
    const el = scroller.current?.querySelector(`[data-area-tab="${CSS.escape(activeArea ?? '')}"]`);
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }, [activeArea, areas.length]);
  const scrollStep = (dir: number) => scroller.current?.scrollBy({ left: dir * Math.max(160, (scroller.current?.clientWidth ?? 0) * 0.7), behavior: 'smooth' });
  // 꾹 눌러 옮기는 중에 ‹ › 위에 올려 두면 계속 넘긴다
  const hoverTimer = useRef<number | undefined>(undefined);
  const stopHoverScroll = () => {
    window.clearInterval(hoverTimer.current);
    hoverTimer.current = undefined;
  };
  const startHoverScroll = (dir: number) => {
    if (!document.body.classList.contains('area-picking')) return;
    stopHoverScroll();
    hoverTimer.current = window.setInterval(() => scroller.current?.scrollBy({ left: dir * 12 }), 16);
  };
  useEffect(() => stopHoverScroll, []);

  // ── 영역 목록 (검색) ─────────────────────────────
  const [list, setList] = useState<{ x: number; y: number } | null>(null);
  const [query, setQuery] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!list) return;
    const close = (e: MouseEvent) => !listRef.current?.contains(e.target as Node) && setList(null);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setList(null);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [list]);
  const q = query.trim().toLowerCase().replace(/\s+/g, '');
  const found = areas.filter((a) => !q || a.name.toLowerCase().replace(/\s+/g, '').includes(q));
  const pick = (id: string | null) => {
    setActiveArea(id);
    setList(null);
    setQuery('');
  };

  // 새 영역: 빈 영역을 만들고 바로 이름을 쓰게 한다 (고른 테이블로 묶기는 여러 개 선택의 "새 영역으로 묶기")
  const addArea = () => {
    let id = '';
    edit((d) => {
      id = createArea(d, { name: '새 영역' }).id;
    });
    setActiveArea(id);
    setRenaming(id);
  };

  return (
    <div className="area-tabs" role="tablist" aria-label="주제영역">
      <button role="tab" aria-selected={!active} className={`area-tab area-tab--all${!active ? ' active' : ''}`} data-area-tab="" onClick={() => setActiveArea(null)} title="모든 테이블">
        전체 <span className="area-tab__count">{tableCount}</span>
      </button>
      <div className={`area-tabs__wrap${edges.left ? ' fade-left' : ''}${edges.right ? ' fade-right' : ''}`}>
        {edges.left && (
          <button className="area-tabs__arrow left" aria-label="앞 영역" title="앞 영역 (마우스 휠로도 넘깁니다)" onClick={() => scrollStep(-1)} onMouseEnter={() => startHoverScroll(-1)} onMouseLeave={stopHoverScroll}>
            ‹
          </button>
        )}
        <div
          className="area-tabs__scroller"
          ref={scroller}
          onScroll={updateEdges}
          // 세로 휠로도 탭 줄을 가로로 넘긴다
          onWheel={(e) => {
            if (scroller.current && Math.abs(e.deltaY) > Math.abs(e.deltaX)) scroller.current.scrollLeft += e.deltaY;
          }}
        >
          {areas.map((a) => (
            <div key={a.id} className={`area-tab${a.id === active?.id ? ' active' : ''}`} data-area-tab={a.id} style={{ ['--area-color' as string]: a.color || 'var(--accent)' }}>
              {renaming === a.id ? (
                <input
                  className="area-tab__rename"
                  defaultValue={a.name}
                  autoFocus
                  onFocus={(e) => e.target.select()}
                  onBlur={(e) => {
                    const name = e.target.value.trim();
                    if (name && name !== a.name) edit((d) => void updateArea(d, a.id, { name }));
                    setRenaming(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                    if (e.key === 'Escape') setRenaming(null);
                  }}
                  aria-label="영역 이름"
                />
              ) : (
                <button
                  role="tab"
                  aria-selected={a.id === active?.id}
                  className="area-tab__label"
                  onClick={() => setActiveArea(a.id)}
                  onDoubleClick={() => !readOnly && setRenaming(a.id)}
                  title={`${a.name} 영역 · 테이블 ${a.tableIds.length}개 · 점선 카드는 다른 영역 테이블${readOnly ? '' : ' · 더블클릭: 이름 바꾸기 · 테이블을 꾹 누른 채 끌어 놓으면 이 영역으로 옮김'}`}
                >
                  <span className="area-tab__dot" />
                  {a.name} <span className="area-tab__count">{a.tableIds.length}</span>
                </button>
              )}
              {a.id === active?.id && !readOnly && renaming !== a.id && (
                <button
                  className="area-tab__more"
                  aria-label="영역 메뉴"
                  title="이름·색·지우기"
                  onClick={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    setMenu(menu?.id === a.id ? null : { id: a.id, x: r.left, y: r.bottom });
                  }}
                >
                  <Icon name="more" size={14} />
                </button>
              )}
            </div>
          ))}
        </div>
        {edges.right && (
          <button className="area-tabs__arrow right" aria-label="뒤 영역" title="뒤 영역 (마우스 휠로도 넘깁니다)" onClick={() => scrollStep(1)} onMouseEnter={() => startHoverScroll(1)} onMouseLeave={stopHoverScroll}>
            ›
          </button>
        )}
      </div>
      {!readOnly && (
        <button className="area-tab area-tab--add" onClick={addArea} disabled={!synced} title="새 주제영역 (빈 영역). 고른 테이블로 만들려면 여러 개 선택에서 새 영역으로 묶기">
          <Icon name="plus" size={14} /> 영역
        </button>
      )}
      {areas.length > 0 && (
        <button
          className={`area-tab area-tab--list${list ? ' open' : ''}`}
          title="영역 목록 · 검색"
          aria-haspopup="dialog"
          aria-expanded={Boolean(list)}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setList(list ? null : { x: r.right, y: r.bottom });
            setQuery('');
          }}
        >
          <Icon name="list" size={14} /> {areas.length}
        </button>
      )}

      {menu && (() => {
        const a = areas.find((x) => x.id === menu.id);
        if (!a) return null;
        return (
          <div className="area-menu" ref={menuRef} role="menu" style={{ left: menu.x, top: menu.y }}>
            <button role="menuitem" onClick={() => { setMenu(null); setRenaming(a.id); }}>이름 바꾸기</button>
            <div className="area-menu__colors" aria-label="색">
              <ColorPicker value={a.color} onChange={(color) => color && edit((d) => void updateArea(d, a.id, { color }))} />
            </div>
            <button
              role="menuitem"
              className="danger"
              onClick={() => {
                setMenu(null);
                if (!confirm(`"${a.name}" 영역을 지울까요? 테이블은 지워지지 않고 전체에 그대로 남습니다.`)) return;
                edit((d) => removeArea(d, a.id));
                setActiveArea(null);
              }}
            >
              영역 지우기 (테이블은 남음)
            </button>
          </div>
        );
      })()}

      {list && (
        <div className="area-list" ref={listRef} role="dialog" aria-label="영역 목록" style={{ right: Math.max(8, window.innerWidth - list.x), top: list.y + 4 }}>
          <input
            className="area-list__search"
            autoFocus
            value={query}
            placeholder={`영역 ${areas.length}개 중 찾기`}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && found[0]) pick(found[0].id);
            }}
            aria-label="영역 찾기"
          />
          <div className="area-list__items">
            {!q && (
              <button className={`area-list__item${!active ? ' active' : ''}`} onClick={() => pick(null)}>
                <span className="area-list__name">전체</span>
                <span className="area-tab__count">{tableCount}</span>
              </button>
            )}
            {found.map((a) => (
              <button key={a.id} className={`area-list__item${a.id === active?.id ? ' active' : ''}`} style={{ ['--area-color' as string]: a.color || 'var(--accent)' }} onClick={() => pick(a.id)}>
                <span className="area-tab__dot" />
                <span className="area-list__name">{a.name}</span>
                <span className="area-tab__count">{a.tableIds.length}</span>
              </button>
            ))}
            {found.length === 0 && <div className="muted small area-list__empty">"{query.trim()}"에 맞는 영역이 없습니다</div>}
          </div>
          <div className="area-list__foot muted small">점선 카드는 다른 영역 테이블 · 테이블을 꾹 누른 채 탭으로 끌어 놓으면 그 영역으로 옮겨집니다</div>
        </div>
      )}
    </div>
  );
}
