// 설치형 앱 새 버전 안내.
// 서버(/api/desktop/latest)가 알려 주는 최신 릴리스와 앱 버전을 비교해 "업데이트하시겠습니까?"를 띄운다.
// "나중에"를 누르면 그날(자정까지)은 다시 띄우지 않고, 상단의 "업데이트" 버튼만 남긴다.

import { create } from 'zustand';
import { desktop } from './desktop';

export interface DesktopRelease {
  version: string;
  name: string;
  notes: string;
  url: string;
  page: string;
  publishedAt: string;
}

const SNOOZE_KEY = 'erd.desktopUpdate.snooze';
const CHECK_INTERVAL = 60 * 60 * 1000;
const FOCUS_INTERVAL = 10 * 60 * 1000;

/** a가 b보다 새 버전이면 true (1.2.10 > 1.2.9) */
export function isNewer(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0;
  }
  return false;
}

/** 오늘 자정(내 PC 시각) */
function endOfToday(now = new Date()): number {
  const d = new Date(now);
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

function snoozed(version: string): boolean {
  try {
    const v = JSON.parse(localStorage.getItem(SNOOZE_KEY) ?? 'null') as { version: string; until: number } | null;
    return Boolean(v && v.version === version && Date.now() < v.until);
  } catch {
    return false;
  }
}

interface UpdateState {
  /** 새 버전이 있으면 그 릴리스 */
  release: DesktopRelease | null;
  open: boolean;
  /** 내려받는 중이면 진행률 (모르면 -1) */
  progress: number | null;
  /** 0.1.x 앱에서 브라우저로 설치 파일을 받게 했으면 true */
  openedInBrowser: boolean;
  error: string;
  check(): Promise<void>;
  show(): void;
  close(): void;
  /** 나중에: 오늘은 다시 띄우지 않는다 */
  later(): void;
  install(): Promise<void>;
}

export const useDesktopUpdate = create<UpdateState>((set, get) => ({
  release: null,
  open: false,
  progress: null,
  openedInBrowser: false,
  error: '',
  async check() {
    if (!desktop) return;
    try {
      const res = await fetch('/api/desktop/latest', { credentials: 'same-origin' });
      if (!res.ok) return;
      const latest = (await res.json()) as DesktopRelease;
      if (!isNewer(latest.version, desktop.version)) return set({ release: null, open: false });
      const first = get().release?.version !== latest.version;
      set({ release: latest, open: get().open || (first && !snoozed(latest.version)) });
    } catch {
      // 확인하지 못하면 다음에 다시
    }
  },
  show: () => set({ open: true, error: '' }),
  close: () => set({ open: false }),
  later() {
    const release = get().release;
    if (release) {
      try {
        localStorage.setItem(SNOOZE_KEY, JSON.stringify({ version: release.version, until: endOfToday() }));
      } catch {
        // 저장이 막혀 있어도 지금은 닫는다
      }
    }
    set({ open: false });
  },
  async install() {
    const release = get().release;
    if (!release || !desktop) return;
    if (!desktop.installUpdate) {
      // 0.1.x 앱: 앱 안에서 바로 설치하는 기능이 없어 브라우저로 설치 파일을 받는다
      window.open(release.url, '_blank');
      set({ openedInBrowser: true, error: '' });
      return;
    }
    set({ progress: -1, error: '' });
    const stop = desktop.onUpdateProgress?.((percent) => set({ progress: percent }));
    try {
      await desktop.installUpdate(release.url);
      set({ progress: 100 });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      set({ progress: null, error: message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') });
    } finally {
      stop?.();
    }
  },
}));

/** 앱이 열려 있는 동안 주기적으로 확인한다 */
export function startDesktopUpdateCheck(): () => void {
  if (!desktop) return () => {};
  let last = 0;
  const check = () => {
    last = Date.now();
    void useDesktopUpdate.getState().check();
  };
  // 앱을 켜 둔 채 새 버전이 나와도 알 수 있게: 창으로 돌아올 때마다(10분에 한 번까지) 다시 확인
  const onFocus = () => Date.now() - last > FOCUS_INTERVAL && check();
  check();
  const timer = setInterval(check, CHECK_INTERVAL);
  window.addEventListener('focus', onFocus);
  return () => {
    clearInterval(timer);
    window.removeEventListener('focus', onFocus);
  };
}
