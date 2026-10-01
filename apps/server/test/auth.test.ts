import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { PGlite } from '@electric-sql/pglite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { readSchema, writeSchema } from '@erd/core';
import { buildApp, type ErdApp } from '../src/app';
import { isPrivateAddress } from '../src/auth';
import { PostgresStorage } from '../src/storage';

const apps: ErdApp[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.app.close();
});

function setup(extra: Parameters<typeof buildApp>[0] = {}) {
  const erd = buildApp({
    dataDir: mkdtempSync(join(tmpdir(), 'erd-auth-')),
    secret: 'test-secret',
    webUrl: 'https://erd.example.com',
    auth: { enabled: true, devLogin: true },
    ...extra,
  });
  apps.push(erd);
  return erd;
}

async function login(app: ErdApp['app'], name: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/auth/dev', payload: { name } });
  return (res.headers['set-cookie'] as string).split(';')[0];
}

const createTable = { op: 'createTable', name: 'member', columns: [{ name: 'member_id', type: 'BIGINT', primaryKey: true }] };

describe('로그인 모드: 권한', () => {
  it('로그인 없이는 API를 쓸 수 없다', async () => {
    const { app } = setup();
    expect((await app.inject({ method: 'GET', url: '/api/projects' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/me' })).json()).toMatchObject({ authEnabled: true, user: null, loginMethods: ['dev'] });
  });

  it('다른 사람의 프로젝트는 보이지 않고, 초대 링크로 들어오면 그 권한만 갖는다', async () => {
    const { app } = setup();
    const a = await login(app, '앨리스');
    const b = await login(app, '밥');
    const as = (cookie: string) => ({ headers: { cookie } });

    const project = (await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'A의 프로젝트' }, ...as(a) })).json();
    expect(project.role).toBe('owner');
    expect((await app.inject({ method: 'GET', url: '/api/projects', ...as(b) })).json()).toEqual([]);
    expect((await app.inject({ method: 'GET', url: `/api/projects/${project.id}`, ...as(b) })).statusCode).toBe(404);

    // 보기 권한으로 초대
    const viewShare = (await app.inject({ method: 'POST', url: `/api/projects/${project.id}/shares`, payload: { role: 'viewer' }, ...as(a) })).json();
    expect(viewShare.url).toBe(`https://erd.example.com/#/join/${viewShare.token}`);
    expect((await app.inject({ method: 'POST', url: `/api/join/${viewShare.token}`, ...as(b) })).json()).toMatchObject({ projectId: project.id, role: 'viewer' });
    expect((await app.inject({ method: 'GET', url: `/api/projects/${project.id}`, ...as(b) })).json().role).toBe('viewer');
    const denied = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/commands`, payload: { commands: [createTable] }, ...as(b) });
    expect(denied.statusCode).toBe(403);

    // 편집 권한으로 올리기
    const editShare = (await app.inject({ method: 'POST', url: `/api/projects/${project.id}/shares`, payload: { role: 'editor' }, ...as(a) })).json();
    await app.inject({ method: 'POST', url: `/api/join/${editShare.token}`, ...as(b) });
    expect((await app.inject({ method: 'POST', url: `/api/projects/${project.id}/commands`, payload: { commands: [createTable] }, ...as(b) })).statusCode).toBe(200);
    // 편집자도 삭제·공유 관리·AI의 DB 실행 허용은 못 한다
    expect((await app.inject({ method: 'DELETE', url: `/api/projects/${project.id}`, ...as(b) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/api/projects/${project.id}/shares`, payload: { role: 'editor' }, ...as(b) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PATCH', url: `/api/projects/${project.id}`, payload: { aiAllowDbExecute: true }, ...as(b) })).statusCode).toBe(403);

    // 소유자는 멤버를 볼 수 있고 내보낼 수 있다
    const access = (await app.inject({ method: 'GET', url: `/api/projects/${project.id}/access`, ...as(a) })).json();
    expect(access.members.map((m: { user: { name: string }; role: string }) => `${m.user.name}:${m.role}`).sort()).toEqual(['밥:editor', '앨리스:owner']);
    const bobId = access.members.find((m: { role: string }) => m.role === 'editor').user.id;
    await app.inject({ method: 'DELETE', url: `/api/projects/${project.id}/members/${bobId}`, ...as(a) });
    expect((await app.inject({ method: 'GET', url: `/api/projects/${project.id}`, ...as(b) })).statusCode).toBe(404);

    // 취소한 초대 링크는 쓸 수 없다
    await app.inject({ method: 'DELETE', url: `/api/projects/${project.id}/shares/${editShare.token}`, ...as(a) });
    expect((await app.inject({ method: 'POST', url: `/api/join/${editShare.token}`, ...as(b) })).statusCode).toBe(404);
  });

  it('DB 연결은 만든 사람만 보고 쓸 수 있다', async () => {
    const { app } = setup();
    const a = await login(app, 'a');
    const b = await login(app, 'b');
    const conn = (await app.inject({
      method: 'POST', url: '/api/connections', headers: { cookie: a },
      payload: { name: 'A DB', dialect: 'mysql', host: 'db.example.com', port: 3306, user: 'u', database: 'd', password: 'p' },
    })).json();
    expect((await app.inject({ method: 'GET', url: '/api/connections', headers: { cookie: b } })).json()).toEqual([]);
    expect((await app.inject({ method: 'POST', url: `/api/connections/${conn.id}/introspect`, headers: { cookie: b } })).statusCode).toBe(404);
  });

  it('배포 환경에서는 내부망 주소의 DB에 연결하지 못한다 (SSRF 방지)', async () => {
    const { app } = setup();
    const a = await login(app, 'a');
    const res = await app.inject({
      method: 'POST', url: '/api/connections/test', headers: { cookie: a },
      payload: { name: 'x', dialect: 'mysql', host: '127.0.0.1', port: 3306, user: 'u', database: 'd', password: 'p' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toContain('내부망 주소');
    expect(['10.0.0.1', '172.20.1.1', '192.168.0.10', '169.254.169.254', '::1', '::ffff:127.0.0.1', '100.64.0.1'].every(isPrivateAddress)).toBe(true);
    expect(['8.8.8.8', '172.32.0.1', '2606:4700::1111'].some(isPrivateAddress)).toBe(false);
  });
});

describe('로그인 모드: 실시간 편집 권한', () => {
  it('보기 권한은 문서를 받기만 하고 바꿀 수 없다. 로그인하지 않으면 접속할 수 없다', async () => {
    const erd = setup();
    const { app } = erd;
    const a = await login(app, 'a');
    const b = await login(app, 'b');
    const project = (await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'p' }, headers: { cookie: a } })).json();
    await app.inject({ method: 'POST', url: `/api/projects/${project.id}/commands`, payload: { commands: [createTable] }, headers: { cookie: a } });
    const share = (await app.inject({ method: 'POST', url: `/api/projects/${project.id}/shares`, payload: { role: 'viewer' }, headers: { cookie: a } })).json();
    await app.inject({ method: 'POST', url: `/api/join/${share.token}`, headers: { cookie: b } });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as { port: number }).port;

    const withCookie = (cookie?: string) =>
      class extends WebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols, cookie ? { headers: { cookie } } : {});
        }
      };

    // 보기 권한: 문서는 받는다
    const doc = new Y.Doc();
    const provider = new WebsocketProvider(`ws://127.0.0.1:${port}/ws`, project.id, doc, { WebSocketPolyfill: withCookie(b) as never });
    await new Promise<void>((resolve) => provider.on('sync', (s: boolean) => s && resolve()));
    expect(readSchema(doc).tables.map((t) => t.name)).toEqual(['member']);
    // 고쳐도 서버에는 반영되지 않는다
    const edited = readSchema(doc);
    edited.tables[0].name = 'hacked';
    doc.transact(() => writeSchema(doc, edited));
    await new Promise((r) => setTimeout(r, 300));
    expect(erd.projects.schema(project.id).tables[0].name).toBe('member');
    provider.destroy();

    // 로그인하지 않은 접속은 거절
    const anon = new WebSocket(`ws://127.0.0.1:${port}/ws/${project.id}`);
    const code = await new Promise<string>((resolve) => {
      anon.on('unexpected-response', (_req, res) => resolve(String(res.statusCode)));
      anon.on('open', () => resolve('open'));
    });
    expect(code).toBe('403');
  });
});

describe('로그인 모드: 개인 MCP 토큰', () => {
  it('토큰 주인의 프로젝트만 다루고, 취소하면 쓸 수 없다', async () => {
    const { app } = setup();
    const a = await login(app, 'a');
    const b = await login(app, 'b');
    await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'A 프로젝트' }, headers: { cookie: a } });
    await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'B 프로젝트' }, headers: { cookie: b } });
    const token = (await app.inject({ method: 'POST', url: '/api/tokens', payload: { name: 'Claude' }, headers: { cookie: a } })).json();
    expect(token.token).toMatch(/^erd_/);
    // 목록에는 원문이 없다
    expect(JSON.stringify((await app.inject({ method: 'GET', url: '/api/tokens', headers: { cookie: a } })).json())).not.toContain(token.token);

    await app.listen({ port: 0, host: '127.0.0.1' });
    const url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}/mcp`;
    const client = new Client({ name: 't', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token.token}` } } }));
    const list = JSON.parse(((await client.callTool({ name: 'list_projects', arguments: {} })) as { content: { text: string }[] }).content[0].text);
    expect(list.map((p: { name: string }) => p.name)).toEqual(['A 프로젝트']);
    await client.close();

    await app.inject({ method: 'DELETE', url: `/api/tokens/${token.id}`, headers: { cookie: a } });
    const revoked = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token.token}`, 'content-type': 'application/json' }, body: '{}' });
    expect(revoked.status).toBe(401);
  });
});

describe('PostgreSQL 저장소 (배포용)', () => {
  it('서버를 다시 시작해도 프로젝트·버전·연결이 남아 있다', async () => {
    const pg = new PGlite();
    const first = buildApp({ storage: await PostgresStorage.open(pg), secret: 's' });
    const project = (await first.app.inject({ method: 'POST', url: '/api/projects', payload: { name: '보존 테스트' } })).json();
    await first.app.inject({ method: 'POST', url: `/api/projects/${project.id}/commands`, payload: { commands: [createTable] } });
    await first.app.inject({ method: 'POST', url: `/api/projects/${project.id}/versions`, payload: { name: 'v1' } });
    await first.app.inject({ method: 'POST', url: '/api/connections', payload: { name: 'c', dialect: 'mysql', host: 'h', port: 3306, user: 'u', database: 'd', password: 'pw' } });
    await first.app.close(); // 문서 저장 + 밀린 쓰기 완료

    const second = buildApp({ storage: await PostgresStorage.open(pg), secret: 's' });
    apps.push(second);
    const reopened = (await second.app.inject({ method: 'GET', url: `/api/projects/${project.id}` })).json();
    expect(reopened.schema.tables.map((t: { name: string }) => t.name)).toEqual(['member']);
    expect((await second.app.inject({ method: 'GET', url: `/api/projects/${project.id}/versions` })).json().map((v: { name: string }) => v.name)).toEqual(['v1']);
    const conns = (await second.app.inject({ method: 'GET', url: '/api/connections' })).json();
    expect(conns).toMatchObject([{ name: 'c', hasPassword: true }]);
    // 같은 키로 비밀번호를 복호화할 수 있다
    expect(second.connections.config(conns[0].id, 'local').password).toBe('pw');
  });
});
