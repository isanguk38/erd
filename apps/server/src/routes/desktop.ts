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
        // GitHub에 닿지 않으면 이전 값을 쓰되 1분 뒤 다시 확인하고, 이전 값도 없으면 "모름"
        if (cache) cache.at = Date.now() - CACHE_MS + 60_000;
        if (!cache) return reply.status(503).send({ error: `최신 버전을 확인하지 못했습니다: ${e instanceof Error ? e.message : String(e)}` });
      }
    }
    if (!cache?.value) return reply.status(404).send({ error: '내려받을 수 있는 릴리스가 없습니다' });
    return cache.value;
  });
}

/**
 * GitHub API로 최신 릴리스를 읽는다. API는 IP당 시간 제한(60회)이 있어 여러 서비스가 IP를 같이 쓰는
 * 호스팅에서는 자주 막히므로, 막히면 일반 웹 주소(/releases/latest 이동 + releases.atom 피드)로 읽는다.
 */
async function defaultFetch(): Promise<GithubRelease> {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'erd-server' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    return (await res.json()) as GithubRelease;
  } catch (apiError) {
    try {
      return await fetchWithoutApi();
    } catch (e) {
      throw new Error(`${apiError instanceof Error ? apiError.message : String(apiError)} / ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

export async function fetchWithoutApi(): Promise<GithubRelease> {
  // 최신 릴리스 주소는 /releases/tag/v0.2.0 으로 이동한다 (초안·미리보기 릴리스는 빠짐)
  const latest = await fetch(`https://github.com/${REPO}/releases/latest`, { redirect: 'manual', signal: AbortSignal.timeout(8000) });
  const tag = /\/releases\/tag\/([^/?#]+)$/.exec(latest.headers.get('location') ?? '')?.[1];
  if (!tag) throw new Error(`최신 릴리스 주소를 찾지 못했습니다 (${latest.status})`);
  const version = decodeURIComponent(tag).replace(/^v/i, '');
  const feed = await fetch(`https://github.com/${REPO}/releases.atom`, { signal: AbortSignal.timeout(8000) }).then((r) => (r.ok ? r.text() : ''));
  const entry = feed.split('<entry>').find((e) => e.includes(`/releases/tag/${tag}"`)) ?? '';
  const pick = (re: RegExp) => re.exec(entry)?.[1] ?? '';
  return {
    tag_name: tag,
    name: unescapeXml(pick(/<title>([\s\S]*?)<\/title>/)) || tag,
    body: htmlToNotes(unescapeXml(pick(/<content type="html">([\s\S]*?)<\/content>/))),
    html_url: `https://github.com/${REPO}/releases/tag/${tag}`,
    published_at: pick(/<updated>([^<]+)<\/updated>/),
    draft: false,
    prerelease: false,
    assets: [{ name: `ERD-Setup-${version}.exe`, browser_download_url: `https://github.com/${REPO}/releases/download/${tag}/ERD-Setup-${version}.exe` }],
  };
}

function unescapeXml(text: string): string {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

/** 릴리스 설명 HTML을 화면이 읽는 간단한 형식(## 제목, - 목록)으로 바꾼다 */
export function htmlToNotes(html: string): string {
  return unescapeXml(
    html
      .replace(/<h[1-6][^>]*>/gi, '\n## ')
      .replace(/<li[^>]*>/gi, '\n- ')
      .replace(/<\/(p|h[1-6]|li|ul|ol)>|<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}
