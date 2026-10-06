import { useEffect, useState } from 'react';

// 화면 테마: 라이트(기본) 또는 다크. 이 브라우저에만 저장한다.
// 시스템 설정은 따르지 않는다 — 언제나 data-theme을 붙여 CSS의 시스템 다크 규칙이 끼어들지 않게 한다.

export type ThemeSetting = 'light' | 'dark';
const KEY = 'erd-theme';
const listeners = new Set<() => void>();

export function getThemeSetting(): ThemeSetting {
  try {
    return localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export function applyTheme(setting: ThemeSetting = getThemeSetting()): void {
  document.documentElement.dataset.theme = setting;
}

export function setThemeSetting(setting: ThemeSetting): void {
  try {
    localStorage.setItem(KEY, setting);
  } catch {
    /* 저장 못 해도 지금 화면에는 적용 */
  }
  applyTheme(setting);
  listeners.forEach((fn) => fn());
}

/** 지금 쓰는 테마 */
export function useTheme(): { setting: ThemeSetting; effective: ThemeSetting } {
  const [setting, setSetting] = useState(getThemeSetting);
  useEffect(() => {
    const onChange = () => setSetting(getThemeSetting());
    listeners.add(onChange);
    return () => void listeners.delete(onChange);
  }, []);
  return { setting, effective: setting };
}
