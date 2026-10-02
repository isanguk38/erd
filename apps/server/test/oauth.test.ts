import { afterEach, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type ErdApp } from '../src/app';

const apps: ErdApp[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.app.close();
});

const PUBLIC = 'https://erd.example.com';
const REDIRECT = 'http://localhost:33418/callback';

function setup() {
  const erd = buildApp({ dataDir: mkdtempSync(join(tmpdir(), 'erd-oauth-')), secret: 'test-secret', webUrl: PUBLIC, auth: { enabled: true, devLogin: true } });
  apps.push(erd);
  return erd;
}

const form = (data: Record<string, string>) => ({
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  payload: new URLSearchParams(data).toString(),
});
const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};
const mcpList = (app: ErdApp['app'], token: string) =>
  app.inject({
    method: 'POST',
    url: '/mcp',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    payload: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
  });

/** MCP 클라이언트(Claude 등)가 하는 순서 그대로: 등록 → 브라우저 로그인·허용 → 토큰 */
async function connect(app: ErdApp['app'], name = '상욱') {
  const client = (await app.inject({ method: 'POST', url: '/oauth/register', payload: { client_name: 'Claude Code', redirect_uris: [REDIRECT] } })).json();
  const { verifier, challenge } = pkce();
  const authorizeUrl = `/oauth/authorize?${new URLSearchParams({
    response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz', resource: `${PUBLIC}/mcp`,
  })}`;
  // 로그인 안 한 브라우저 → 로그인 화면 → (개발용) 로그인 → 허용 화면으로 돌아옴
  const login = await app.inject({ method: 'GET', url: authorizeUrl });
  const loggedIn = await app.inject({ method: 'POST', url: '/oauth/dev-login', ...form({ name, return: authorizeUrl }) });
  const cookie = (loggedIn.headers['set-cookie'] as string).split(';')[0];
  const consent = await app.inject({ method: 'GET', url: loggedIn.headers.location as string, headers: { cookie } });
  const requestId = /name="request_id" value="([^"]+)"/.exec(consent.body)![1];
  const approved = await app.inject({ method: 'POST', url: '/oauth/authorize', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: `request_id=${requestId}&decision=allow` });
  const back = new URL(approved.headers.location as string);
  return { client, verifier, login, loggedIn, consent, approved, back, cookie, code: back.searchParams.get('code')! };
}

describe('MCP 로그인 (OAuth)', () => {
  it('토큰 없이 MCP에 오면 401과 로그인 안내 주소를 준다', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'POST', url: '/mcp', payload: {} });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toBe(`Bearer resource_metadata="${PUBLIC}/.well-known/oauth-protected-resource"`);
    const resource = (await app.inject({ method: 'GET', url: '/.well-known/oauth-protected-resource' })).json();
    expect(resource).toMatchObject({ resource: `${PUBLIC}/mcp`, authorization_servers: [PUBLIC] });
    const server = (await app.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server' })).json();
    expect(server).toMatchObject({
      issuer: PUBLIC,
      authorization_endpoint: `${PUBLIC}/oauth/authorize`,
      token_endpoint: `${PUBLIC}/oauth/token`,
      registration_endpoint: `${PUBLIC}/oauth/register`,
      code_challenge_methods_supported: ['S256'],
    });
  });

  it('등록 → 로그인 → 허용 → 토큰 → MCP 사용 → 갱신 → 연결 끊기', async () => {
    const { app } = setup();
    const c = await connect(app);
    expect(c.login.body).toContain('ERD에 로그인하세요');
    expect(c.login.headers['x-frame-options']).toBe('DENY');
    expect(c.consent.body).toContain('Claude Code');
    expect(c.consent.body).toContain('허용');
    expect(c.back.origin + c.back.pathname).toBe(REDIRECT);
    expect(c.back.searchParams.get('state')).toBe('xyz');

    // 틀린 verifier는 거절, 맞으면 발급. code는 한 번만 쓴다
    const wrong = await app.inject({ method: 'POST', url: '/oauth/token', ...form({ grant_type: 'authorization_code', code: c.code, client_id: c.client.client_id, redirect_uri: REDIRECT, code_verifier: 'nope' }) });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error).toBe('invalid_grant');

    const c2 = await connect(app);
    const tokenRes = await app.inject({ method: 'POST', url: '/oauth/token', ...form({ grant_type: 'authorization_code', code: c2.code, client_id: c2.client.client_id, redirect_uri: REDIRECT, code_verifier: c2.verifier }) });
    expect(tokenRes.statusCode).toBe(200);
    expect(tokenRes.headers['cache-control']).toBe('no-store');
    const tokens = tokenRes.json();
    expect(tokens).toMatchObject({ token_type: 'Bearer', expires_in: 3600 });
    expect(tokens.access_token).toMatch(/^erdo_/);
    const reuse = await app.inject({ method: 'POST', url: '/oauth/token', ...form({ grant_type: 'authorization_code', code: c2.code, client_id: c2.client.client_id, redirect_uri: REDIRECT, code_verifier: c2.verifier }) });
    expect(reuse.json().error).toBe('invalid_grant');

    // 받은 토큰으로 MCP 사용, API도 같은 사용자로
    const list = await mcpList(app, tokens.access_token);
    expect(list.statusCode).toBe(200);
    expect(list.body).toContain('edit_schema');
    const me = (await app.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${tokens.access_token}` } })).json();
    expect(me.user.login).toBe('dev-상욱');

    // 갱신: 새 토큰을 받고, 쓴 refresh_token은 다시 못 쓴다
    const refreshed = (await app.inject({ method: 'POST', url: '/oauth/token', ...form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: c2.client.client_id }) })).json();
    expect(refreshed.access_token).toMatch(/^erdo_/);
    expect(refreshed.access_token).not.toBe(tokens.access_token);
    const again = await app.inject({ method: 'POST', url: '/oauth/token', ...form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token }) });
    expect(again.json().error).toBe('invalid_grant');

    // 연결된 앱 목록에서 끊으면 그 토큰은 바로 못 쓴다
    const grants = (await app.inject({ method: 'GET', url: '/api/oauth/grants', headers: { cookie: c2.cookie } })).json();
    expect(grants).toHaveLength(1);
    expect(grants[0].clientName).toBe('Claude Code');
    await app.inject({ method: 'DELETE', url: `/api/oauth/grants/${grants[0].id}`, headers: { cookie: c2.cookie } });
    expect((await mcpList(app, refreshed.access_token)).statusCode).toBe(401);
    const afterRevoke = await app.inject({ method: 'POST', url: '/oauth/token', ...form({ grant_type: 'refresh_token', refresh_token: refreshed.refresh_token }) });
    expect(afterRevoke.json().error).toBe('invalid_grant');
  });

  it('거부하면 access_denied, 이상한 요청은 막는다', async () => {
    const { app } = setup();
    const badRedirect = await app.inject({ method: 'POST', url: '/oauth/register', payload: { redirect_uris: ['http://evil.example.com/cb'] } });
    expect(badRedirect.statusCode).toBe(400);

    const client = (await app.inject({ method: 'POST', url: '/oauth/register', payload: { client_name: 'Claude', redirect_uris: [REDIRECT] } })).json();
    const { challenge } = pkce();
    const q = (extra: Record<string, string>) =>
      `/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', ...extra })}`;
    // 등록하지 않은 주소로 돌려보내기·PKCE 없음 → 화면에서 거절 (code를 다른 곳으로 보내지 않는다)
    expect((await app.inject({ method: 'GET', url: q({ redirect_uri: 'https://evil.example.com/cb' }) })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: q({ code_challenge_method: 'plain' }) })).statusCode).toBe(400);
    // 내 PC 주소는 포트가 달라도 된다 (Claude Code는 매번 다른 포트를 쓴다)
    expect((await app.inject({ method: 'GET', url: q({ redirect_uri: 'http://localhost:50123/callback' }) })).statusCode).toBe(200);

    const cookie = ((await app.inject({ method: 'POST', url: '/auth/dev', payload: { name: 'a' } })).headers['set-cookie'] as string).split(';')[0];
    const consent = await app.inject({ method: 'GET', url: q({ state: 's1' }), headers: { cookie } });
    const requestId = /name="request_id" value="([^"]+)"/.exec(consent.body)![1];
    const denied = await app.inject({ method: 'POST', url: '/oauth/authorize', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: `request_id=${requestId}&decision=deny` });
    const back = new URL(denied.headers.location as string);
    expect(back.searchParams.get('error')).toBe('access_denied');
    expect(back.searchParams.get('state')).toBe('s1');
    expect(back.searchParams.get('code')).toBeNull();

    // 로그인 없이 허용을 보내면 안 된다
    const noLogin = await app.inject({ method: 'POST', url: '/oauth/authorize', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: `request_id=${requestId}&decision=allow` });
    expect(noLogin.statusCode).toBe(401);
  });

  it('같은 앱으로 다시 로그인(재인증)하면 연결이 쌓이지 않고 바뀐다', async () => {
    const { app } = setup();
    const exchange = async (c: Awaited<ReturnType<typeof connect>>) =>
      (await app.inject({ method: 'POST', url: '/oauth/token', ...form({ grant_type: 'authorization_code', code: c.code, client_id: c.client.client_id, redirect_uri: REDIRECT, code_verifier: c.verifier }) })).json();
    const first = await connect(app);
    const t1 = await exchange(first);
    const second = await connect(app); // 재인증: 클라이언트가 다시 등록·로그인한다
    const t2 = await exchange(second);
    const grants = (await app.inject({ method: 'GET', url: '/api/oauth/grants', headers: { cookie: second.cookie } })).json();
    expect(grants.map((g: { clientName: string }) => g.clientName)).toEqual(['Claude Code']);
    expect((await mcpList(app, t1.access_token)).statusCode).toBe(401);
    expect((await mcpList(app, t2.access_token)).statusCode).toBe(200);
  });

  it('예전 방식 토큰(erd_...)은 새로 만들 수 없지만, 이미 있는 것은 그대로 쓴다', async () => {
    const erd = setup();
    const { app } = erd;
    const cookie = ((await app.inject({ method: 'POST', url: '/auth/dev', payload: { name: 'b' } })).headers['set-cookie'] as string).split(';')[0];
    expect((await app.inject({ method: 'POST', url: '/api/tokens', headers: { cookie }, payload: { name: 'MCP' } })).statusCode).toBe(404);
    const me = (await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).json().user;
    const { token } = erd.auth.createToken(me.id, 'MCP');
    expect((await mcpList(app, token)).statusCode).toBe(200);
  });
});
