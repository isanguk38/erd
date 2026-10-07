import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type ErdApp } from '../src/app';

// 설치형 앱이 이 PC의 Claude Code로 설계 검토를 바로 실행할 때 쓰는 서버 기능
const apps: ErdApp[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.app.close();
});

const mcpList = (app: ErdApp['app'], token: string) =>
  app.inject({
    method: 'POST',
    url: '/mcp',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    payload: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
  });

describe('앱에서 AI 바로 실행', () => {
  it('로그인 모드: 화면 로그인으로 짧은 MCP 토큰을 받고, 연결된 앱에 하나로 보이며, 끊으면 못 쓴다', async () => {
    const erd = buildApp({ dataDir: mkdtempSync(join(tmpdir(), 'erd-airun-')), secret: 's', webUrl: 'https://erd.example.com', auth: { enabled: true, devLogin: true } });
    apps.push(erd);
    const { app } = erd;
    const login = await app.inject({ method: 'POST', url: '/auth/dev', payload: { name: '상욱' } });
    const cookie = (login.headers['set-cookie'] as string).split(';')[0];
    const first = (await app.inject({ method: 'POST', url: '/api/ai-run-token', headers: { cookie } })).json();
    expect(first.url).toBe('https://erd.example.com/mcp');
    expect(first.token).toMatch(/^erdo_/);
    expect(first.expiresIn).toBe(7200);
    expect((await mcpList(app, first.token)).statusCode).toBe(200);
    // 두 번 받아도 연결된 앱 목록에는 하나
    await app.inject({ method: 'POST', url: '/api/ai-run-token', headers: { cookie } });
    const grants = (await app.inject({ method: 'GET', url: '/api/oauth/grants', headers: { cookie } })).json();
    expect(grants.map((g: { clientName: string }) => g.clientName)).toEqual(['ERD 앱 · 이 PC의 AI']);
    // MCP 토큰으로는 토큰을 더 만들 수 없다
    const viaToken = await app.inject({ method: 'POST', url: '/api/ai-run-token', headers: { authorization: `Bearer ${first.token}` } });
    expect(viaToken.statusCode).toBe(403);
    // 연결 끊기 → 받은 토큰을 바로 못 쓴다
    await app.inject({ method: 'DELETE', url: `/api/oauth/grants/${grants[0].id}`, headers: { cookie } });
    expect((await mcpList(app, first.token)).statusCode).toBe(401);
  });

  it('로컬 모드: 로컬 MCP 주소와 공용 토큰', async () => {
    const erd = buildApp({ dataDir: mkdtempSync(join(tmpdir(), 'erd-airun-')), mcpToken: 'erd_local_token_for_test_123456' });
    apps.push(erd);
    await erd.app.listen({ port: 0, host: '127.0.0.1' });
    const r = (await erd.app.inject({ method: 'POST', url: '/api/ai-run-token' })).json();
    expect(r.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(r.token).toBe('erd_local_token_for_test_123456');
  });

  it('"AI 작업 중" 표시: 시작할 때 넣고 끝나면 지운다 (실행한 사람 이름은 서버가 채움)', async () => {
    const erd = buildApp({ dataDir: mkdtempSync(join(tmpdir(), 'erd-airun-')) });
    apps.push(erd);
    const p = (await erd.app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'p' } })).json();
    await erd.app.inject({ method: 'PATCH', url: `/api/projects/${p.id}`, payload: { aiRun: { mode: 'fix', by: '가짜 이름' } } });
    expect(erd.projects.meta(p.id).aiRun).toMatchObject({ mode: 'fix', by: '나' });
    await erd.app.inject({ method: 'PATCH', url: `/api/projects/${p.id}`, payload: { aiRun: null } });
    expect(erd.projects.meta(p.id).aiRun).toBeNull();
  });
});
