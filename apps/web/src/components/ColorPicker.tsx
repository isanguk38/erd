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
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !pop.current?.contains(e.target as Node) && setOpen(null);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(null);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
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
  const [hex, setHex] = useState(current && HEX.test(current) ? current : '');
  const input = useRef<HTMLInputElement>(null);
  // 색 선택기를 끄는 동안 값이 계속 바뀌므로(input 이벤트) 다 고른 뒤(change)에만 저장한다
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    const commit = () => onChangeRef.current(el.value.toLowerCase());
    el.addEventListener('change', commit);
    return () => el.removeEventListener('change', commit);
  }, []);
  const applyHex = () => {
    const v = (hex.startsWith('#') ? hex : `#${hex}`).trim().toLowerCase();
    if (HEX.test(v)) onChange(v);
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
        <label className={`color-chip color-chip--custom${custom ? ' active' : ''}${disabled ? ' disabled' : ''}`} title="직접 고르기 (스펙트럼·스포이드)" style={custom ? { background: custom } : undefined}>
          <input ref={input} type="color" disabled={disabled} defaultValue={custom ?? '#3b82f6'} aria-label="색 직접 고르기" />
        </label>
        <input
          className="color-grid__hex mono"
          value={hex}
          placeholder="#3b82f6"
          maxLength={7}
          disabled={disabled}
          onChange={(e) => setHex(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && applyHex()}
          onBlur={() => hex && hex !== current && applyHex()}
          aria-label="HEX 색 코드"
        />
      </div>
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
