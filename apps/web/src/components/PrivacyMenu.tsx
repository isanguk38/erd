// 개인정보 표시: 편집 창 컬럼 줄의 자물쇠 버튼. 누르면 종류(고유식별정보·비밀번호·금융·민감·일반)와 암호화 여부를 고른다.
// 컬럼 목록은 가로로 넘치면 스크롤되는 상자라, 메뉴는 화면 기준(position: fixed)으로 띄운다.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { guessPrivacy, PRIVACY_HINT, PRIVACY_KINDS, PRIVACY_LABEL, PRIVACY_MUST_ENCRYPT, privacyText, type Column, type ColumnPrivacy } from '@erd/core';
import { Icon } from './ui';

export function PrivacyMenu({ column, disabled, onChange }: { column: Column; disabled?: boolean; onChange: (privacy: ColumnPrivacy | undefined) => void }) {
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const p = column.privacy;
  const guess = p ? null : guessPrivacy(column);

  useEffect(() => {
    if (!at) return;
    const close = (e: Event) => {
      if (menu.current?.contains(e.target as Node) || button.current?.contains(e.target as Node)) return;
      setAt(null);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setAt(null);
    // 편집 창이 스크롤돼 버튼이 움직이면 닫는다 (다른 곳의 스크롤은 무시)
    const start = button.current?.getBoundingClientRect();
    const moved = () => {
      const now = button.current?.getBoundingClientRect();
      if (!start || !now || Math.abs(now.top - start.top) > 2 || Math.abs(now.left - start.left) > 2) setAt(null);
    };
    document.addEventListener('pointerdown', close, true);
    document.addEventListener('keydown', esc);
    window.addEventListener('scroll', moved, true);
    return () => {
      document.removeEventListener('pointerdown', close, true);
      document.removeEventListener('keydown', esc);
      window.removeEventListener('scroll', moved, true);
    };
  }, [at]);

  const open = () => {
    if (at) return setAt(null);
    const r = button.current!.getBoundingClientRect();
    // 오른쪽 끝 버튼이라 메뉴는 버튼 오른쪽 끝에 맞춰 왼쪽으로 펼친다
    setAt({ top: r.bottom + 4, left: Math.max(8, r.right - 300) });
  };
  // 아래에 자리가 없으면 버튼 위로 펼친다 (그래도 넘치면 화면 안으로)
  useLayoutEffect(() => {
    if (!at || !menu.current || !button.current) return;
    const h = menu.current.offsetHeight;
    if (at.top + h <= window.innerHeight - 8) return;
    const above = button.current.getBoundingClientRect().top - h - 4;
    const top = Math.max(8, above >= 8 ? above : window.innerHeight - h - 8);
    if (top !== at.top) setAt({ ...at, top });
  }, [at]);
  const pick = (next: ColumnPrivacy | undefined) => {
    onChange(next);
    setAt(null);
  };

  const title = p
    ? `개인정보: ${privacyText(p)}${PRIVACY_MUST_ENCRYPT.has(p.kind) && !p.encrypted ? ' — 암호화 표시 없음' : ''} (눌러서 바꾸기)`
    : guess
      ? `${PRIVACY_LABEL[guess]}로 보입니다 — 눌러서 개인정보로 표시`
      : '개인정보로 표시';
  const warn = p && PRIVACY_MUST_ENCRYPT.has(p.kind) && !p.encrypted;

  return (
    <>
      <button
        ref={button}
        className={`icon-btn privacy-btn${p ? ` on privacy-${p.kind}` : ''}${warn ? ' warn' : ''}${guess ? ' guess' : ''}`}
        title={title}
        aria-label={title}
        disabled={disabled}
        onClick={open}
      >
        <Icon name="lock" size={13} />
      </button>
      {at && (
        <div className="privacy-menu" ref={menu} style={{ top: at.top, left: at.left }} role="menu">
          <div className="privacy-menu__head">
            <b>{column.name}</b> 개인정보 표시
            <span className="muted small">ERD에만 저장 (SQL·DB에는 영향 없음)</span>
          </div>
          {PRIVACY_KINDS.map((kind) => (
            <button key={kind} role="menuitemradio" aria-checked={p?.kind === kind} className={p?.kind === kind ? 'active' : ''} onClick={() => pick({ kind, ...(p?.encrypted ? { encrypted: true } : {}) })}>
              <span className={`privacy-dot privacy-${kind}`} />
              <span className="privacy-menu__label">
                {PRIVACY_LABEL[kind]}
                {guess === kind && <span className="privacy-menu__guess">이름으로 보면 이것</span>}
              </span>
              <span className="privacy-menu__hint">{PRIVACY_HINT[kind]}</span>
            </button>
          ))}
          {p && (
            <>
              <label className="privacy-menu__check">
                <input type="checkbox" checked={Boolean(p.encrypted)} onChange={(e) => onChange({ kind: p.kind, ...(e.target.checked ? { encrypted: true } : {}) })} />
                {p.kind === 'password' ? '일방향 암호화(해시)해서 저장' : '암호화해서 저장'}
                {PRIVACY_MUST_ENCRYPT.has(p.kind) && <span className="muted small"> — 법으로 정해진 항목</span>}
              </label>
              <button className="privacy-menu__clear" onClick={() => pick(undefined)}>개인정보 표시 지우기</button>
            </>
          )}
        </div>
      )}
    </>
  );
}
