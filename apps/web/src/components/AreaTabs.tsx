import { useEffect, useRef, useState } from 'react';
import { AREA_COLORS, createArea, removeArea, updateArea } from '@erd/core';
import { selectAreas, useStore } from '../store';
import { Icon } from './ui';

/**
 * 주제영역 탭: [전체] [주문] [회원] … [+ 영역]
 * 탭을 누르면 그 영역 테이블만 보인다. 테이블을 끌어 탭에 놓으면 그 영역으로 옮긴다 (Canvas가 처리, data-area-tab).
 * 고른 영역의 ⋯ 메뉴: 이름 바꾸기·색·영역 지우기 (테이블은 남음). 탭을 더블클릭해도 이름을 바꾼다.
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
      <button role="tab" aria-selected={!active} className={`area-tab${!active ? ' active' : ''}`} data-area-tab="" onClick={() => setActiveArea(null)} title="모든 테이블">
        전체 <span className="area-tab__count">{tableCount}</span>
      </button>
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
              title={`${a.name} 영역 · 테이블 ${a.tableIds.length}개${readOnly ? '' : ' · 더블클릭: 이름 바꾸기 · 테이블을 꾹 누른 채 끌어 놓으면 이 영역으로 옮김'}`}
            >
              <span className="area-tab__dot" />
              {a.name} <span className="area-tab__count">{a.tableIds.length}</span>
            </button>
          )}
          {a.id === active?.id && !readOnly && renaming !== a.id && (
            <button className="area-tab__more" aria-label="영역 메뉴" title="이름·색·지우기" onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setMenu(menu?.id === a.id ? null : { id: a.id, x: r.left, y: r.bottom });
              }}>
              <Icon name="more" size={14} />
            </button>
          )}
          {menu?.id === a.id && (
            <div className="area-menu" ref={menuRef} role="menu" style={{ left: menu.x, top: menu.y }}>
              <button role="menuitem" onClick={() => { setMenu(null); setRenaming(a.id); }}>이름 바꾸기</button>
              <div className="area-menu__colors" aria-label="색">
                {AREA_COLORS.map((c) => (
                  <button key={c} className={`color-chip${a.color === c ? ' active' : ''}`} style={{ background: c }} title={c} onClick={() => edit((d) => void updateArea(d, a.id, { color: c }))} />
                ))}
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
          )}
        </div>
      ))}
      {!readOnly && (
        <button className="area-tab area-tab--add" onClick={addArea} disabled={!synced} title="새 주제영역 (빈 영역). 고른 테이블로 만들려면 여러 개 선택에서 새 영역으로 묶기">
          <Icon name="plus" size={14} /> 영역
        </button>
      )}
      {active && <span className="area-tabs__hint muted small">점선 카드는 다른 영역 테이블 · 테이블을 꾹 누른 채 탭으로 끌어 놓으면 그 영역으로 옮겨집니다</span>}
    </div>
  );
}
