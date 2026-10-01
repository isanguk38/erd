// 배포가 바뀌면 예전 화면은 지워진 파일(assets/*-해시.js)을 불러오다 실패한다.
// 1) 그런 실패가 나면 한 번 새로고침해서 새 버전을 받고,
// 2) 열어 둔 화면(특히 설치형 앱)에는 새 버전이 나왔다고 미리 알려준다.

const RELOADED_AT = 'erd-chunk-reload-at';

/** 지금 화면이 불러온 메인 파일 (예: /assets/index-BK3ssKNT.js). 개발 서버에서는 null */
function currentEntry(): string | null {
  const src = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/index-"]')?.getAttribute('src');
  return src ? new URL(src, location.href).pathname : null;
}

/** 서버의 최신 메인 파일 */
async function latestEntry(): Promise<string | null> {
  const html = await fetch('/', { cache: 'no-store' }).then((r) => (r.ok ? r.text() : ''));
  const m = html.match(/\/assets\/index-[A-Za-z0-9_-]+\.js/);
  return m ? m[0] : null;
}

/** 새 버전이 배포됐는지 */
export async function hasNewVersion(): Promise<boolean> {
  const current = currentEntry();
  if (!current) return false;
  try {
    const latest = await latestEntry();
    return Boolean(latest && latest !== current);
  } catch {
    return false;
  }
}

/** 예전 버전 파일을 못 불러온 오류인지 (브라우저마다 문구가 다르다) */
function isStaleChunkError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /dynamically imported module|Importing a module script failed|error loading dynamically imported module|Failed to fetch/i.test(msg);
}

/**
 * 필요할 때 불러오는 모듈(엑셀, 자동 배치 등)을 가져온다.
 * 새 배포로 예전 파일이 지워져 실패하면 오류 대신 한 번 새로고침해 새 버전을 받는다
 * (1분 안에 또 실패하면 반복하지 않고 원래 오류를 낸다).
 */
export async function loadModule<T>(load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch (e) {
    if (!isStaleChunkError(e)) throw e;
    let last = 0;
    try {
      last = Number(sessionStorage.getItem(RELOADED_AT) ?? 0);
    } catch {
      /* 저장소를 못 써도 아래에서 판단 */
    }
    if (Date.now() - last < 60_000) throw e;
    try {
      sessionStorage.setItem(RELOADED_AT, String(Date.now()));
    } catch {
      /* 무시 */
    }
    location.reload();
    return new Promise<T>(() => {}); // 새로고침되는 동안 기다린다
  }
}
