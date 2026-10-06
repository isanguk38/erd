import { useRef, useState, type ReactNode } from 'react';

const KEY = 'erd.sideWidth';
const DEFAULT_WIDTH = 640;
const MIN_WIDTH = 360;

function readWidth(): number {
  try {
    const v = Number(localStorage.getItem(KEY));
    return Number.isFinite(v) && v >= MIN_WIDTH ? v : DEFAULT_WIDTH;
  } catch {
    return DEFAULT_WIDTH;
  }
}

/** 오른쪽 편집 창: 왼쪽 가장자리를 끌어 폭을 바꾼다 (기억함). 더블클릭하면 기본 폭으로 */
export function ResizableSide({ children }: { children: ReactNode }) {
  const [width, setWidth] = useState(readWidth);
  const drag = useRef<{ x: number; width: number } | null>(null);

  const save = (w: number) => {
    try {
      localStorage.setItem(KEY, String(Math.round(w)));
    } catch {
      // 저장이 막혀 있어도 지금 화면에는 적용된다
    }
  };
  const clamp = (w: number) => Math.max(MIN_WIDTH, Math.min(w, Math.max(MIN_WIDTH, window.innerWidth * 0.85)));

  return (
    <div className="side-resizable" style={{ ['--side-width' as string]: `${width}px` }}>
      <div
        className="side-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="편집 창 폭 조절"
        title="끌어서 폭 조절 · 더블클릭: 기본 폭"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { x: e.clientX, width };
          document.body.classList.add('resizing-side');
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          setWidth(clamp(drag.current.width + (drag.current.x - e.clientX)));
        }}
        onPointerUp={(e) => {
          if (!drag.current) return;
          const w = clamp(drag.current.width + (drag.current.x - e.clientX));
          drag.current = null;
          document.body.classList.remove('resizing-side');
          setWidth(w);
          save(w);
        }}
        onDoubleClick={() => {
          setWidth(DEFAULT_WIDTH);
          save(DEFAULT_WIDTH);
        }}
      />
      {children}
    </div>
  );
}
