import type { FastifyInstance } from 'fastify';

// 설치형 앱 최신 버전 안내: GitHub 릴리스(최신)를 읽어 버전·변경 내용·설치 파일 주소를 알려 준다.
// 앱 화면이 자기 버전과 비교해 "업데이트하시겠습니까?"를 띄운다. GitHub 호출은 10분 동안 재사용한다.

const REPO = 'isanguk38/erd';
const CACHE_MS = 10 * 60 * 1000;

export interface DesktopRelease {
  version: string;
  name: string;
  notes: string;
  /** 설치 파일(ERD-Setup-x.y.z.exe) 내려받기 주소 */
  url: string;
  /** 릴리스 페이지 */
  page: string;
  publishedAt: string;
}

interface GithubRelease {
  tag_name: string;
  name: string | null;
  body: string | null;
  html_url: string;
  published_at: string;
  draft: boolean;
  prerelease: boolean;
  assets: { name: string; browser_download_url: string }[];
}

export function toDesktopRelease(release: GithubRelease): DesktopRelease | null {
  if (release.draft || release.prerelease) return null;
  const installer = release.assets.find((a) => /^ERD-Setup-.*\.exe$/i.test(a.name));
  if (!installer) return null;
  const version = release.tag_name.replace(/^v/i, '');
  if (!/^\d+\.\d+\.\d+$/.test(version)) return null;
  return {
    version,
    name: release.name || release.tag_name,
    notes: (release.body ?? '').trim(),
    url: installer.browser_download_url,
    page: release.html_url,
    publishedAt: release.published_at,
  };
}

export function registerDesktopRoutes(app: FastifyInstance, fetchLatest: () => Promise<GithubRelease> = defaultFetch) {
  let cache: { at: number; value: DesktopRelease | null } | null = null;
  app.get('/api/desktop/latest', async (_req, reply) => {
    if (!cache || Date.now() - cache.at > CACHE_MS) {
      try {
        cache = { at: Date.now(), value: toDesktopRelease(await fetchLatest()) };
      } catch (e) {
        // GitHub에 닿지 않으면 이전 값을 쓰고, 그것도 없으면 "모름"
        if (!cache) return reply.status(503).send({ error: `최신 버전을 확인하지 못했습니다: ${e instanceof Error ? e.message : String(e)}` });
      }
    }
    if (!cache?.value) return reply.status(404).send({ error: '내려받을 수 있는 릴리스가 없습니다' });
    return cache.value;
  });
}

async function defaultFetch(): Promise<GithubRelease> {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'erd-server' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}`);
  return (await res.json()) as GithubRelease;
}
