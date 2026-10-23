import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type ErdApp } from '../src/app';

const apps: ErdApp[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const a of apps.splice(0)) await a.app.close();
});

const PUBLIC = 'https://erd.example.com';

function setup() {
  const erd = buildApp({
    dataDir: mkdtempSync(join(tmpdir(), 'erd-ms-')),
    secret: 'test-secret',
    webUrl: PUBLIC,
    auth: { enabled: true, microsoft: { clientId: 'client-123', clientSecret: 'secret-xyz', tenant: 'common' } },
    adminOwners: ['owner@outlook.com'],
  });
  apps.push(erd);
  return erd;
}

/** Microsoft 서버 흉내: 토큰 → Graph /me */
function fakeMicrosoft(profile: { id: string; displayName: string; mail: string | null; userPrincipalName: string }) {
  const calls: { url: string; body?: string }[] = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? String(init.body) : undefined });
    if (String(url).includes('/oauth2/v2.0/token')) return new Response(JSON.stringify({ access_token: 'ms-access' }), { status: 200 });
    if (String(url).startsWith('https://graph.microsoft.com/v1.0/me')) return new Response(JSON.stringify(profile), { status: 200 });
    return new Response('{}', { status: 404 });
  });
  return calls;
}

async function signIn(app: ErdApp['app']) {
  const start = await app.inject({ method: 'GET', url: '/auth/microsoft' });
  const location = new URL(start.headers.location as string);
  const stateCookie = (start.headers['set-cookie'] as string[]).find((c) => c.startsWith('erd_oauth_state='))!.split(';')[0]!;
  const state = location.searchParams.get('state')!;
  const done = await app.inject({ method: 'GET', url: `/auth/microsoft/callback?code=abc&state=${state}`, headers: { cookie: stateCookie } });
  const session = (done.headers['set-cookie'] as string[]).find((c) => c.startsWith('erd_session='))!.split(';')[0]!;
  return { start, location, done, session };
}

describe('Microsoft 로그인', () => {
  it('로그인 방법에 microsoft, Microsoft 로그인 화면으로 보낸다 (개인·회사·학교 계정, 상태 값으로 위조 방지)', async () => {
    const { app } = setup();
    expect((await app.inject({ method: 'GET', url: '/api/me' })).json().loginMethods).toEqual(['microsoft']);
    const start = await app.inject({ method: 'GET', url: '/auth/microsoft' });
    expect(start.statusCode).toBe(302);
    const loc = new URL(start.headers.location as string);
    expect(loc.origin + loc.pathname).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
    expect(loc.searchParams.get('client_id')).toBe('client-123');
    expect(loc.searchParams.get('redirect_uri')).toBe(`${PUBLIC}/auth/microsoft/callback`);
    expect(loc.searchParams.get('scope')).toContain('User.Read');
    expect(loc.searchParams.get('state')).toBeTruthy();
    expect(loc.searchParams.get('client_secret')).toBeNull();
  });

  it('돌아오면 계정을 만들고 로그인 (아이디 = 이메일), 다시 로그인하면 같은 계정', async () => {
    const { app } = setup();
    const calls = fakeMicrosoft({ id: 'ms-oid-1', displayName: '이상욱', mail: 'Owner@Outlook.com', userPrincipalName: 'owner_outlook.com#EXT#@x.onmicrosoft.com' });
    const first = await signIn(app);
    expect(first.done.statusCode).toBe(302);
    expect(first.done.headers.location).toBe(`${PUBLIC}/`);
    const me = (await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: first.session } })).json();
    expect(me.user).toMatchObject({ login: 'owner@outlook.com', name: '이상욱', microsoftId: 'ms-oid-1' });
    // 비밀 값은 서버끼리만 (토큰 요청 본문), 주소에는 없다
    expect(calls.find((c) => c.url.includes('/token'))!.body).toContain('client_secret=secret-xyz');
    // 관리자 주인도 이메일로 지정할 수 있다
    expect((await app.inject({ method: 'GET', url: '/api/admin/me', headers: { cookie: first.session } })).json().role).toBe('owner');

    const second = await signIn(app);
    const me2 = (await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: second.session } })).json();
    expect(me2.user.id).toBe(me.user.id);
  });

  it('관리자 초대를 Microsoft 이메일로 지정하면 그 계정만 수락할 수 있다', async () => {
    const { app } = setup();
    fakeMicrosoft({ id: 'ms-owner', displayName: '주인', mail: 'owner@outlook.com', userPrincipalName: 'owner@outlook.com' });
    const owner = await signIn(app);
    const made = await app.inject({ method: 'POST', url: '/api/admin/invites', headers: { cookie: owner.session }, payload: { login: 'Kim@Company.com' } });
    const token = (made.json().url as string).split('/join/')[1];

    fakeMicrosoft({ id: 'ms-other', displayName: '다른 사람', mail: 'other@company.com', userPrincipalName: 'other@company.com' });
    const other = await signIn(app);
    const refused = await app.inject({ method: 'POST', url: '/api/admin/invites/accept', headers: { cookie: other.session }, payload: { token } });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toMatch(/Microsoft 계정 Kim@Company.com만/);

    fakeMicrosoft({ id: 'ms-kim', displayName: '김', mail: 'kim@company.com', userPrincipalName: 'kim@company.com' });
    const kim = await signIn(app);
    const accepted = await app.inject({ method: 'POST', url: '/api/admin/invites/accept', headers: { cookie: kim.session }, payload: { token } });
    expect(accepted.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/admin/me', headers: { cookie: kim.session } })).json().role).toBe('admin');
  });

  it('상태 값이 다르거나, 사용자가 취소하면 로그인하지 않는다', async () => {
    const { app } = setup();
    fakeMicrosoft({ id: 'x', displayName: 'x', mail: 'x@x.com', userPrincipalName: 'x@x.com' });
    const start = await app.inject({ method: 'GET', url: '/auth/microsoft' });
    const stateCookie = (start.headers['set-cookie'] as string[]).find((c) => c.startsWith('erd_oauth_state='))!.split(';')[0]!;
    const forged = await app.inject({ method: 'GET', url: '/auth/microsoft/callback?code=abc&state=forged', headers: { cookie: stateCookie } });
    expect(forged.statusCode).toBe(400);
    expect(forged.headers['set-cookie']).toBeUndefined();
    const cancelled = await app.inject({ method: 'GET', url: '/auth/microsoft/callback?error=access_denied&error_description=The+user+has+cancelled' });
    expect(cancelled.statusCode).toBe(400);
    expect(cancelled.json().error).toMatch(/Microsoft 로그인을 마치지 못했습니다/);
  });
});
