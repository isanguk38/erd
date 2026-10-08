import { useEffect, useRef } from 'react';
import { COLOR_PALETTE } from '@erd/core';

/** 테이블 색 '기본'이 쓰는 테마 강조색 (styles.css의 --accent) */
const DEFAULT_ACCENT = '#2563eb';

/**
 * 색 고르기: 기본 팔레트 + "직접 고르기"(브라우저 색 선택기 — 스펙트럼·스포이드·HEX 입력).
 * 테이블 색·주제영역 색에 같이 쓴다. allowDefault면 맨 앞에 "기본"(테마 강조색)을 둔다.
 * value: 지금 색 (없으면 기본, null이면 여러 개를 골라 색이 섞인 상태 — 아무것도 표시 안 함)
 */
export function ColorPicker({ value, onChange, allowDefault, disabled }: { value?: string | null; onChange: (color: string | undefined) => void; allowDefault?: boolean; disabled?: boolean }) {
  const current = value?.toLowerCase();
  const custom = current && /^#[0-9a-f]{6}$/.test(current) && !COLOR_PALETTE.includes(current) ? current : null;
  // "기본"은 테마 강조색(파랑)이라 팔레트의 같은 파랑은 빼서 같은 색이 두 번 나오지 않게
  const palette = allowDefault ? COLOR_PALETTE.filter((c) => c !== DEFAULT_ACCENT) : COLOR_PALETTE;
  const input = useRef<HTMLInputElement>(null);
  // 선택기를 끄는 동안 값이 계속 바뀌므로(input 이벤트) 다 고른 뒤(change)에만 저장한다
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    const commit = () => onChangeRef.current(el.value.toLowerCase());
    el.addEventListener('change', commit);
    return () => el.removeEventListener('change', commit);
  }, []);
  return (
    <div className="colors">
      {allowDefault && <button className={`color-chip color-chip--default${value === undefined || value === '' ? ' active' : ''}`} title="기본 (테마 색)" disabled={disabled} onClick={() => onChange(undefined)} />}
      {palette.map((c) => (
        <button key={c} className={`color-chip${current === c ? ' active' : ''}`} style={{ background: c }} title={c} disabled={disabled} onClick={() => onChange(c)} />
      ))}
      {custom && <button className="color-chip active" style={{ background: custom }} title={`직접 고른 색 ${custom}`} disabled={disabled} onClick={() => input.current?.click()} />}
      <label className={`color-chip color-chip--custom${disabled ? ' disabled' : ''}`} title="직접 고르기 (스펙트럼·스포이드·HEX 입력)">
        <input ref={input} type="color" disabled={disabled} defaultValue={custom ?? '#3b82f6'} aria-label="색 직접 고르기" />
      </label>
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
