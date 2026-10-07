import { useEffect, useRef, useState, type ReactNode } from 'react';

/** 간단한 선 아이콘 (24 그리드, currentColor) */
const PATHS: Record<string, string> = {
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-5-5',
  help: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17.5h.01',
  sparkles: 'M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z',
  share: 'M16 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM16 22a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM8.6 13.5l4.8 2.9M13.4 6.6l-4.8 2.9',
  plus: 'M12 5v14M5 12h14',
  undo: 'M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3',
  redo: 'M15 14l5-5-5-5M20 9H9a5 5 0 0 0 0 10h3',
  layout: 'M3 3h7v7H3zM14 3h7v4h-7zM14 11h7v10h-7zM3 14h7v7H3z',
  dbIn: 'M12 3c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3zM4 6v6c0 1.7 3.6 3 8 3M20 6v4M4 12v6c0 1.7 3.6 3 8 3M17 14v7M14 18l3 3 3-3',
  dbOut: 'M12 3c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3zM4 6v6c0 1.7 3.6 3 8 3M20 6v4M4 12v6c0 1.7 3.6 3 8 3M17 21v-7M14 17l3-3 3 3',
  history: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 3',
  download: 'M12 3v12M7 10l5 5 5-5M5 21h14',
  back: 'M15 18l-6-6 6-6',
  chevron: 'M6 9l6 6 6-6',
  close: 'M6 6l12 12M18 6L6 18',
  desktop: 'M3 4h18v12H3zM8 20h8M12 16v4',
  check: 'M4 12l5 5L20 6',
  moon: 'M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z',
  sun: 'M12 4V2M12 22v-2M4 12H2M22 12h-2M5.6 5.6 4.2 4.2M19.8 19.8l-1.4-1.4M5.6 18.4l-1.4 1.4M19.8 4.2l-1.4 1.4M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z',
  comment: 'M4 5h16v11H9l-5 4z',
  external: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  area: 'M3 6h7l2 2h9v11H3z',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
};

export function Icon({ name, size = 16 }: { name: keyof typeof PATHS | string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}

export interface MenuItem {
  label: string;
  hint?: string;
  icon?: string;
  disabled?: boolean;
  onClick: () => void;
}

/** 버튼을 누르면 아래로 펼쳐지는 메뉴 */
export function Dropdown({ label, icon, items, title }: { label: ReactNode; icon?: string; items: MenuItem[]; title?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  return (
    <div className="dropdown" ref={ref}>
      <button className={`btn btn-tool${open ? ' active' : ''}`} onClick={() => setOpen(!open)} title={title} aria-haspopup="menu" aria-expanded={open}>
        {icon && <Icon name={icon} />}
        <span>{label}</span>
        <Icon name="chevron" size={14} />
      </button>
      {open && (
        <div className="dropdown__menu" role="menu">
          {items.map((item, i) => (
            <button
              key={`${i}:${item.label}`}
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                setOpen(false);
                item.onClick();
              }}
            >
              {item.icon && <Icon name={item.icon} />}
              <span className="dropdown__label">{item.label}</span>
              {item.hint && <span className="dropdown__hint">{item.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** 단축키 표시 */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd>{children}</kbd>;
}
