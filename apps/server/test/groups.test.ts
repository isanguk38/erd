import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type ErdApp } from '../src/app';

const apps: ErdApp[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.app.close();
});

function setup(auth = true) {
  const erd = buildApp({
    dataDir: mkdtempSync(join(tmpdir(), 'erd-groups-')),
    secret: 'test-secret',
    webUrl: 'https://erd.example.com',
    ...(auth ? { auth: { enabled: true, devLogin: true } } : {}),
  });
  apps.push(erd);
  return erd;
}

async function login(app: ErdApp['app'], name: string) {
  const res = await app.inject({ method: 'POST', url: '/auth/dev', payload: { name } });
  const cookie = (res.headers['set-cookie'] as string).split(';')[0]!;
  return async (method: string, url: string, payload?: unknown) => {
    const r = await app.inject({ method: method as 'GET', url, headers: { cookie }, ...(payload === undefined ? {} : { payload: payload as object }) });
    return { status: r.statusCode, body: r.body ? r.json() : null };
  };
}

describe('프로젝트 그룹', () => {
  it('그룹 안에 하위 그룹·프로젝트, 목록에 그룹 경로, 옮기기', async () => {
    const { app } = setup();
    const a = await login(app, 'alice');
    const company = (await a('POST', '/api/groups', { name: '회사' })).body;
    const shop = (await a('POST', '/api/groups', { name: '쇼핑몰', parentId: company.id })).body;
    expect(shop).toMatchObject({ name: '쇼핑몰', parentId: company.id });
    expect((await a('POST', '/api/groups', { name: '쇼핑몰', parentId: company.id })).body.error).toMatch(/이미 있습니다/);
    expect((await a('POST', '/api/groups', { name: '  ' })).status).toBe(400);

    const order = (await a('POST', '/api/projects', { name: '주문', groupId: shop.id })).body;
    expect(order.groupPath).toEqual([{ id: company.id, name: '회사' }, { id: shop.id, name: '쇼핑몰' }]);
    const top = (await a('POST', '/api/projects', { name: '맨 위' })).body;
    expect(top).toMatchObject({ groupId: null, groupPath: [] });

    const list = (await a('GET', '/api/projects')).body;
    expect(list.find((p: { id: string }) => p.id === order.id)).toMatchObject({ groupId: shop.id });
    expect(list.find((p: { id: string }) => p.id === order.id)).not.toHaveProperty('groupOwner');

    // 옮기기: 그룹으로, 맨 위로
    expect((await a('PUT', `/api/projects/${top.id}/group`, { groupId: company.id })).body.groupPath).toEqual([{ id: company.id, name: '회사' }]);
    expect((await a('PUT', `/api/projects/${top.id}/group`, { groupId: null })).body.groupId).toBeNull();
    // 그룹 옮기기·이름 바꾸기, 자기 하위로는 못 옮김
    expect((await a('PATCH', `/api/groups/${company.id}`, { parentId: shop.id })).body.error).toMatch(/하위 그룹 안으로/);
    expect((await a('PATCH', `/api/groups/${shop.id}`, { name: '쇼핑몰2', parentId: null })).body).toMatchObject({ name: '쇼핑몰2', parentId: null });
    expect((await a('GET', '/api/projects')).body.find((p: { id: string }) => p.id === order.id).groupPath).toEqual([{ id: shop.id, name: '쇼핑몰2' }]);
  });

  it('비어 있을 때만 지운다, 프로젝트를 지우면 그룹 자리도 지운다', async () => {
    const { app } = setup();
    const a = await login(app, 'alice');
    const g = (await a('POST', '/api/groups', { name: '회사' })).body;
    const sub = (await a('POST', '/api/groups', { name: '팀', parentId: g.id })).body;
    const p = (await a('POST', '/api/projects', { name: '주문', groupId: g.id })).body;
    expect((await a('DELETE', `/api/groups/${g.id}`)).body.error).toMatch(/하위 그룹 1개·프로젝트 1개/);
    await a('DELETE', `/api/groups/${sub.id}`);
    await a('DELETE', `/api/projects/${p.id}`);
    expect((await a('DELETE', `/api/groups/${g.id}`)).status).toBe(200);
    expect((await a('GET', '/api/groups')).body).toEqual([]);
  });

  it('공유받은 사람: 그 프로젝트와 그룹 경로(이름)만, 같은 그룹의 다른 프로젝트·그룹은 안 보이고 못 고친다', async () => {
    const { app } = setup();
    const a = await login(app, 'alice');
    const b = await login(app, 'bob');
    const g = (await a('POST', '/api/groups', { name: '회사' })).body;
    const sub = (await a('POST', '/api/groups', { name: '쇼핑몰', parentId: g.id })).body;
    await a('POST', '/api/groups', { name: '비밀 그룹', parentId: g.id });
    const shared = (await a('POST', '/api/projects', { name: '주문', groupId: sub.id })).body;
    await a('POST', '/api/projects', { name: '정산', groupId: sub.id });
    const share = (await a('POST', `/api/projects/${shared.id}/shares`, { role: 'editor' })).body;
    expect((await b('POST', `/api/join/${share.token}`)).status).toBe(200);

    const list = (await b('GET', '/api/projects')).body;
    expect(list.map((p: { name: string }) => p.name)).toEqual(['주문']);
    expect(list[0]).toMatchObject({ role: 'editor', groupPath: [{ id: g.id, name: '회사' }, { id: sub.id, name: '쇼핑몰' }], groupOwner: 'alice' });
    // 남의 그룹은 목록에도 없고, 고치거나 그 안에 만들 수 없다
    expect((await b('GET', '/api/groups')).body).toEqual([]);
    expect((await b('PATCH', `/api/groups/${g.id}`, { name: '해킹' })).status).toBe(404);
    expect((await b('DELETE', `/api/groups/${sub.id}`)).status).toBe(404);
    expect((await b('POST', '/api/groups', { name: 'x', parentId: g.id })).status).toBe(404);
    expect((await b('POST', '/api/projects', { name: 'x', groupId: sub.id })).status).toBe(404);
    // 편집 권한이어도 프로젝트 자리(그룹)는 소유자만
    expect((await b('PUT', `/api/projects/${shared.id}/group`, { groupId: null })).status).toBe(403);
    // 공유받은 사람이 자기 그룹으로 옮기는 것도 안 된다 (소유자의 정리 공간)
    const mine = (await b('POST', '/api/groups', { name: '내 그룹' })).body;
    expect((await a('PUT', `/api/projects/${shared.id}/group`, { groupId: mine.id })).status).toBe(404);
  });

  it('그룹 색: #rrggbb로 정하고, 지우면 기본색, 공유받은 사람의 경로에도 색', async () => {
    const { app } = setup();
    const a = await login(app, 'alice');
    const b = await login(app, 'bob');
    const g = (await a('POST', '/api/groups', { name: '회사', color: '#2563EB' })).body;
    expect(g.color).toBe('#2563eb');
    expect((await a('PATCH', `/api/groups/${g.id}`, { color: 'blue' })).body.error).toMatch(/#rrggbb/);
    expect((await a('PATCH', `/api/groups/${g.id}`, { color: '#16a34a' })).body.color).toBe('#16a34a');
    const p = (await a('POST', '/api/projects', { name: '주문', groupId: g.id })).body;
    const share = (await a('POST', `/api/projects/${p.id}/shares`, { role: 'viewer' })).body;
    await b('POST', `/api/join/${share.token}`);
    expect((await b('GET', '/api/projects')).body[0].groupPath).toEqual([{ id: g.id, name: '회사', color: '#16a34a' }]);
    expect((await a('PATCH', `/api/groups/${g.id}`, { color: null })).body).not.toHaveProperty('color');
  });

  it('로컬 모드(로그인 없음)에서도 쓸 수 있다', async () => {
    const { app } = setup(false);
    const g = (await app.inject({ method: 'POST', url: '/api/groups', payload: { name: '회사' } })).json();
    const p = (await app.inject({ method: 'POST', url: '/api/projects', payload: { name: '주문', groupId: g.id } })).json();
    expect(p.groupPath).toEqual([{ id: g.id, name: '회사' }]);
    expect((await app.inject({ method: 'GET', url: '/api/groups' })).json()).toHaveLength(1);
  });
});
