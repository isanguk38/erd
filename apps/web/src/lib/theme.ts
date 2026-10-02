import { useEffect, useState } from 'react';

// 화면 테마: 시스템 설정을 따르거나 라이트/다크로 고정. 이 브라우저에만 저장한다.

export type ThemeSetting = 'system' | 'light' | 'dark';
const KEY = 'erd-theme';
const listeners = new Set<() => void>();

export function getThemeSetting(): ThemeSetting {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(setting: ThemeSetting = getThemeSetting()): void {
  if (setting === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = setting;
}

export function setThemeSetting(setting: ThemeSetting): void {
  try {
    if (setting === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, setting);
  } catch {
    /* 저장 못 해도 지금 화면에는 적용 */
  }
  applyTheme(setting);
  listeners.forEach((fn) => fn());
}

const systemDark = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches;

/** 지금 실제로 쓰는 테마 (시스템 설정 반영) */
export function useTheme(): { setting: ThemeSetting; effective: 'light' | 'dark' } {
  const [setting, setSetting] = useState(getThemeSetting);
  const [dark, setDark] = useState(systemDark);
  useEffect(() => {
    const onChange = () => setSetting(getThemeSetting());
    listeners.add(onChange);
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const onMq = () => setDark(mq.matches);
    mq.addEventListener('change', onMq);
    return () => {
      listeners.delete(onChange);
      mq.removeEventListener('change', onMq);
    };
  }, []);
  return { setting, effective: setting === 'system' ? (dark ? 'dark' : 'light') : setting };
}
