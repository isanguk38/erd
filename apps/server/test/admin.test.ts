import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type ErdApp } from '../src/app';

const apps: ErdApp[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.app.close();
});

const PUBLIC = 'https://erd.example.com';

function setup(release?: { version: string; body: string }) {
  const erd = buildApp({
    dataDir: mkdtempSync(join(tmpdir(), 'erd-admin-')),
    secret: 'test-secret',
    webUrl: PUBLIC,
    auth: { enabled: true, devLogin: true },
    adminOwners: ['dev-owner'],
    fetchDesktopRelease: async () => ({
      tag_name: `v${release?.version ?? '0.2.9'}`, name: 'ERD', body: release?.body ?? 'GitHub 설명', html_url: 'https://x', published_at: '2026-10-16T00:00:00Z', draft: false, prerelease: false,
      assets: [{ name: `ERD-Setup-${release?.version ?? '0.2.9'}.exe`, browser_download_url: 'https://x/setup.exe' }],
    }),
  });
  apps.push(erd);
  return erd;
}

async function login(app: ErdApp['app'], name: string) {
  const res = await app.inject({ method: 'POST', url: '/auth/dev', payload: { name } });
  const cookie = (res.headers['set-cookie'] as string).split(';')[0]!;
  const call = async (method: string, url: string, payload?: unknown) => {
    const r = await app.inject({ method: method as 'GET', url, headers: { cookie }, ...(payload === undefined ? {} : { payload: payload as object }) });
    return { status: r.statusCode, body: r.body ? r.json() : null };
  };
  return call;
}

describe('관리자 페이지', () => {
  it('주인(서버 설정의 GitHub 계정)만 처음부터 관리자, 일반 사용자는 쓸 수 없고 게시한 글만 읽는다', async () => {
    const { app } = setup();
    const owner = await login(app, 'owner');
    const user = await login(app, 'someone');
    expect((await owner('GET', '/api/admin/me')).body.role).toBe('owner');
    expect((await user('GET', '/api/admin/me')).body.role).toBeNull();
    expect((await user('POST', '/api/admin/notices', { title: 'x' })).status).toBe(403);
    expect((await user('GET', '/api/admin/notices')).status).toBe(403);

    const draft = (await owner('POST', '/api/admin/notices', { kind: 'web', title: '임시 글', body: '아직' })).body;
    const pub = (await owner('POST', '/api/admin/notices', { kind: 'notice', title: '점검 안내', body: '## 주의\n- 내보내기 전 버전 저장', published: true, pinned: true })).body;
    expect(draft.published).toBe(false);
    const list = (await user('GET', '/api/notices')).body;
    expect(list.map((n: { title: string }) => n.title)).toEqual(['점검 안내']);
    expect(list[0]).not.toHaveProperty('revisions');
    // 로그인하지 않으면 읽을 수 없다
    expect((await app.inject({ method: 'GET', url: '/api/notices' })).statusCode).toBe(401);
    expect(pub.createdBy).toBe('dev-owner');
  });

  it('초대: 주인만 만들고, 한 번만·지정한 GitHub 아이디만 수락, 관리자는 글만 쓰고 초대는 못 함, 빼면 바로 못 씀', async () => {
    const { app } = setup();
    const owner = await login(app, 'owner');
    const kim = await login(app, 'kim');
    const lee = await login(app, 'lee');
    expect((await kim('POST', '/api/admin/invites', {})).status).toBe(403);

    // 특정 계정(dev-kim)만 수락 가능한 초대
    const { url } = (await owner('POST', '/api/admin/invites', { login: 'dev-kim' })).body;
    expect(url).toMatch(/^https:\/\/erd\.example\.com\/#\/admin\/join\/[\w-]+\.[\w-]+$/);
    const token = url.split('/join/')[1];
    expect((await lee('POST', '/api/admin/invites/accept', { token })).body.error).toMatch(/dev-kim만 수락/);
    expect((await kim('POST', '/api/admin/invites/accept', { token: token.slice(0, -2) + 'xx' })).body.error).toMatch(/올바르지 않습니다/);
    expect((await kim('POST', '/api/admin/invites/accept', { token })).body.role).toBe('admin');
    // 한 번만
    expect((await lee('POST', '/api/admin/invites/accept', { token })).body.error).toMatch(/이미 사용한/);
    expect((await kim('GET', '/api/admin/me')).body.role).toBe('admin');

    // 관리자는 글을 쓰지만 관리자 관리는 못 한다
    expect((await kim('POST', '/api/admin/notices', { kind: 'web', title: '웹 업데이트', published: true })).status).toBe(200);
    expect((await kim('GET', '/api/admin/admins')).status).toBe(403);
    expect((await kim('POST', '/api/admin/invites', {})).status).toBe(403);

    const admins = (await owner('GET', '/api/admin/admins')).body;
    expect(admins.owners).toEqual(['dev-owner']);
    expect(admins.admins.map((a: { login: string }) => a.login)).toEqual(['dev-kim']);
    expect(admins.invites[0]).toMatchObject({ status: 'used', usedBy: 'dev-kim' });
    expect(admins.invites[0]).not.toHaveProperty('hash');

    await owner('DELETE', `/api/admin/admins/${admins.admins[0].userId}`);
    expect((await kim('GET', '/api/admin/me')).body.role).toBeNull();
    expect((await kim('POST', '/api/admin/notices', { title: 'x' })).status).toBe(403);
  });

  it('관리자 권한은 프로젝트 권한과 따로: 관리자여도 남의 프로젝트는 못 본다', async () => {
    const { app } = setup();
    const owner = await login(app, 'owner');
    const other = await login(app, 'other');
    const p = (await other('POST', '/api/projects', { name: '남의 프로젝트', dialect: 'mysql' })).body;
    expect([403, 404]).toContain((await owner('GET', `/api/projects/${p.id}`)).status);
    expect((await owner('GET', '/api/projects')).body.some((x: { id: string }) => x.id === p.id)).toBe(false);
  });

  it('글 고치기: 이력이 남고 되돌릴 수 있다, 게시 시각은 처음 게시할 때', async () => {
    const { app } = setup();
    const owner = await login(app, 'owner');
    const n = (await owner('POST', '/api/admin/notices', { kind: 'web', title: '첫 제목', body: '첫 내용', published: true })).body;
    expect(n.format).toBe('html');
    expect((await owner('POST', '/api/admin/notices', { kind: 'web', title: 'x', format: 'docx' })).body.error).toMatch(/형식/);
    const edited = (await owner('PATCH', `/api/admin/notices/${n.id}`, { title: '고친 제목' })).body;
    expect(edited.title).toBe('고친 제목');
    expect(edited.publishedAt).toBe(n.publishedAt);
    expect(edited.revisions.map((r: { title: string }) => r.title)).toEqual(['첫 제목']);
    const back = (await owner('POST', `/api/admin/notices/${n.id}/restore`, { at: edited.revisions[0].at })).body;
    expect(back.title).toBe('첫 제목');
    expect(back.revisions.map((r: { title: string }) => r.title)).toEqual(['고친 제목', '첫 제목']);
    // 잘못된 값
    expect((await owner('POST', '/api/admin/notices', { kind: 'app', title: '앱' })).body.error).toMatch(/버전/);
    expect((await owner('POST', '/api/admin/notices', { kind: 'web', title: '' })).body.error).toMatch(/제목/);
    await owner('DELETE', `/api/admin/notices/${n.id}`);
    expect((await owner('GET', '/api/admin/notices')).body).toEqual([]);
  });

  it('앱 업데이트 안내: 그 버전의 게시한 "앱 업데이트" 글이 있으면 그 내용, 없으면 GitHub 릴리스 설명', async () => {
    const { app } = setup({ version: '0.2.9', body: 'GitHub 설명' });
    const owner = await login(app, 'owner');
    expect((await owner('GET', '/api/desktop/latest')).body.notes).toBe('GitHub 설명');
    expect((await owner('GET', '/api/desktop/latest')).body.notesFormat).toBe('markdown');
    const n = (await owner('POST', '/api/admin/notices', { kind: 'app', version: '0.2.9', title: '0.2.9', body: '## 바뀐 점\n- 테스트 데이터', published: false })).body;
    expect((await owner('GET', '/api/desktop/latest')).body.notes).toBe('GitHub 설명');
    await owner('PATCH', `/api/admin/notices/${n.id}`, { published: true });
    expect((await owner('GET', '/api/desktop/latest')).body.notes).toBe('## 바뀐 점\n- 테스트 데이터');
    // 편집기로 쓴 글은 html, GitHub 릴리스 설명은 markdown — 앱 업데이트 창이 형식에 맞게 보여 준다
    expect((await owner('GET', '/api/desktop/latest')).body.notesFormat).toBe('html');
  });

  it('로컬 모드(로그인 없음)에서는 내 PC 사용자가 주인', async () => {
    const erd = buildApp({ dataDir: mkdtempSync(join(tmpdir(), 'erd-admin-local-')), mcpToken: 't' });
    apps.push(erd);
    expect((await erd.app.inject({ method: 'GET', url: '/api/admin/me' })).json().role).toBe('owner');
  });
});
