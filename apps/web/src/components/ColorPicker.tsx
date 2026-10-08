import { useEffect, useRef, useState } from 'react';
import { COLOR_PALETTE } from '@erd/core';
import { Icon } from './ui';

const HEX = /^#[0-9a-f]{6}$/;

/**
 * 색 고르기 (테이블 색·주제영역 색).
 * - 기본: [지금 색 ▾] + "쓰는 색"(이 ERD에서 이미 쓰는 색 몇 개 — 같은 색으로 맞추기 쉽게). 누르면 팝업.
 * - inline: 팝업 없이 격자를 바로 (영역 메뉴처럼 이미 떠 있는 곳).
 * 팝업·격자: 20색 5열(색상환 순서) + 기본(테마 색) + 직접 고르기(스펙트럼·스포이드) + HEX 입력.
 * value: 지금 색 (없으면 기본, null이면 여러 개를 골라 색이 섞인 상태)
 */
export function ColorPicker({
  value,
  onChange,
  allowDefault,
  disabled,
  inline,
  recent = [],
}: {
  value?: string | null;
  onChange: (color: string | undefined) => void;
  allowDefault?: boolean;
  disabled?: boolean;
  inline?: boolean;
  /** 이 ERD에서 쓰는 색 (많이 쓰는 순) */
  recent?: string[];
}) {
  const [open, setOpen] = useState<{ x: number; y: number } | null>(null);
  const pop = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    // 캔버스를 눌러도 닫히게 캡처 단계에서 받는다. 색 버튼은 그 버튼이 열고 닫는다
    const close = (e: MouseEvent) => !pop.current?.contains(e.target as Node) && !trigger.current?.contains(e.target as Node) && setOpen(null);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(null);
    document.addEventListener('pointerdown', close, true);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', close, true);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  const choose = (color: string | undefined) => {
    onChange(color);
    setOpen(null);
  };
  const grid = <ColorGrid value={value} onChange={inline ? onChange : choose} allowDefault={allowDefault} disabled={disabled} />;
  if (inline) return grid;

  const current = value?.toLowerCase();
  const quick = recent.map((c) => c.toLowerCase()).filter((c, i, all) => HEX.test(c) && c !== current && all.indexOf(c) === i).slice(0, 5);
  return (
    <div className="color-picker">
      <button
        ref={trigger}
        className="color-picker__trigger"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={Boolean(open)}
        title={value === null ? '여러 색 (누르면 한 번에 바꿀 색 고르기)' : current ? `${current} · 바꾸기` : '기본 (테마 색) · 바꾸기'}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setOpen(open ? null : { x: r.left, y: r.bottom });
        }}
      >
        <span className={`color-chip${!current && value !== null ? ' color-chip--default' : ''}${value === null ? ' color-chip--mixed' : ''}`} style={current ? { background: current } : undefined} />
        <span className="color-picker__label">{value === null ? '여러 색' : current ?? '기본'}</span>
        <Icon name="chevron" size={12} />
      </button>
      {quick.length > 0 && (
        <span className="color-picker__quick" aria-label="이 ERD에서 쓰는 색">
          <span className="muted small">쓰는 색</span>
          {quick.map((c) => (
            <button key={c} className="color-chip color-chip--sm" style={{ background: c }} title={`${c} (이 ERD에서 쓰는 색)`} disabled={disabled} onClick={() => onChange(c)} />
          ))}
        </span>
      )}
      {open && (
        <div className="color-pop" ref={pop} role="dialog" aria-label="색 고르기" style={{ left: open.x, top: open.y + 4 }}>
          {grid}
        </div>
      )}
    </div>
  );
}

/** 5열 격자 + 기본 + 직접 고르기 + HEX */
function ColorGrid({ value, onChange, allowDefault, disabled }: { value?: string | null; onChange: (color: string | undefined) => void; allowDefault?: boolean; disabled?: boolean }) {
  const current = value?.toLowerCase();
  const custom = current && HEX.test(current) && !COLOR_PALETTE.includes(current) ? current : null;
  // HEX 칸: 지금 색을 보여 주고, 색 선택 창에서 고르는 동안은 고르는 색을 실시간으로 보여 준다
  const [hex, setHex] = useState(current && HEX.test(current) ? current : '');
  useEffect(() => setHex(current && HEX.test(current) ? current : ''), [current]);
  const input = useRef<HTMLInputElement>(null);
  // 색 선택 창(브라우저 기본 창)에는 확인 버튼이 없다: 고르는 동안(input)은 미리 보기만, 창을 닫으면(change) 적용
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    // 고르는 중인 색: 바깥을 눌러 색 선택 창을 닫으면 같은 누름에 이 팝업도 먼저 닫힐 수 있어,
    // 적용(change)이 오기 전에 사라지면 그때 적용한다
    let picking: string | null = null;
    const preview = () => {
      picking = el.value.toLowerCase();
      setHex(picking);
    };
    const commit = () => {
      picking = null;
      onChangeRef.current(el.value.toLowerCase());
    };
    el.addEventListener('input', preview);
    el.addEventListener('change', commit);
    return () => {
      el.removeEventListener('input', preview);
      el.removeEventListener('change', commit);
      if (picking) onChangeRef.current(picking);
    };
  }, []);
  const typed = (hex.startsWith('#') ? hex : `#${hex}`).trim().toLowerCase();
  const valid = HEX.test(typed);
  const pending = valid && typed !== current;
  const apply = () => {
    if (valid) onChange(typed);
  };
  return (
    <div className="color-grid">
      {allowDefault && (
        <button className={`color-grid__default${value === undefined || value === '' ? ' active' : ''}`} disabled={disabled} onClick={() => onChange(undefined)} title="색을 따로 정하지 않음 (테마 색)">
          <span className="color-chip color-chip--default" /> 기본
        </button>
      )}
      <div className="color-grid__cells">
        {COLOR_PALETTE.map((c) => (
          <button key={c} className={`color-chip${current === c ? ' active' : ''}`} style={{ background: c }} title={c} disabled={disabled} onClick={() => onChange(c)} />
        ))}
      </div>
      <div className="color-grid__custom">
        {/* 색상환: 누르면 색 선택 창. 고르는 동안 이 칩과 HEX 칸이 고르는 색으로 바뀐다 */}
        <label
          className={`color-chip color-chip--custom${custom || pending ? ' active' : ''}${disabled ? ' disabled' : ''}`}
          title="직접 고르기 (스펙트럼·스포이드) — 창을 닫으면 적용"
          style={pending ? { background: typed } : custom ? { background: custom } : undefined}
        >
          <input ref={input} type="color" disabled={disabled} defaultValue={custom ?? '#3b82f6'} aria-label="색 직접 고르기" />
        </label>
        <input
          className={`color-grid__hex mono${hex && !valid ? ' invalid' : ''}`}
          value={hex}
          placeholder="#3b82f6"
          maxLength={7}
          disabled={disabled}
          onChange={(e) => setHex(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && apply()}
          aria-label="HEX 색 코드"
        />
        <button className="btn btn-sm btn-primary color-grid__apply" disabled={disabled || !pending} onClick={apply} title="이 색으로 적용 (Enter)">
          적용
        </button>
      </div>
      <div className="color-grid__hint muted">색상환: 창을 닫으면 적용 · HEX: Enter</div>
    </div>
  );
}

/** 배경색 위에 읽기 좋은 글자색 (밝은 배경이면 진한 글자) */
export function readableText(color: string | undefined): string | undefined {
  const m = color?.match(/^#([0-9a-f]{6})$/i);
  if (!m) return undefined;
  const n = parseInt(m[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 0.4 ? '#111827' : '#ffffff';
}

/** 이 ERD에서 쓰는 색 (많이 쓰는 순) */
export function usedColors(colors: (string | undefined)[]): string[] {
  const count = new Map<string, number>();
  for (const c of colors) if (c && HEX.test(c.toLowerCase())) count.set(c.toLowerCase(), (count.get(c.toLowerCase()) ?? 0) + 1);
  return [...count.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
}
