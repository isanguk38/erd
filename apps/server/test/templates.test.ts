import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sampleTemplates } from '@erd/core';
import { buildApp, type ErdApp } from '../src/app';

const apps: ErdApp[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.app.close();
});

function setup(auth: boolean, dataDir = mkdtempSync(join(tmpdir(), 'erd-tpl-'))) {
  const erd = buildApp({ dataDir, secret: 'test-secret', auth: auth ? { enabled: true, devLogin: true } : undefined });
  apps.push(erd);
  return { ...erd, dataDir };
}

async function login(app: ErdApp['app'], name: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/auth/dev', payload: { name } });
  return (res.headers['set-cookie'] as string).split(';')[0];
}

describe('컬럼 템플릿 (계정별)', () => {
  it('계정마다 따로 저장되고, 로그인하지 않으면 쓸 수 없다', async () => {
    const { app } = setup(true);
    const a = await login(app, '상욱');
    const b = await login(app, '친구');
    const [snake] = sampleTemplates();

    expect((await app.inject({ method: 'GET', url: '/api/templates' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/templates', headers: { cookie: a } })).json()).toEqual({ templates: [], defaultTemplateId: null });

    const saved = (await app.inject({ method: 'PUT', url: '/api/templates', headers: { cookie: a }, payload: { templates: [snake], defaultTemplateId: snake.id } })).json();
    expect(saved.templates[0].name).toBe(snake.name);
    expect(saved.defaultTemplateId).toBe(snake.id);

    expect((await app.inject({ method: 'GET', url: '/api/templates', headers: { cookie: a } })).json().templates).toHaveLength(1);
    expect((await app.inject({ method: 'GET', url: '/api/templates', headers: { cookie: b } })).json().templates).toHaveLength(0);
  });

  it('로컬 모드에서도 저장되고 서버를 다시 켜도 남는다. 이상한 값은 정리된다', async () => {
    const first = setup(false);
    await first.app.inject({ method: 'PUT', url: '/api/templates', payload: { templates: [{ name: '내 규격', top: [{ name: 'seq', type: 'INT', primaryKey: true }], bottom: 'oops' }], defaultTemplateId: 'none' } });
    await first.app.close();
    apps.splice(apps.indexOf(first), 1);
    const again = setup(false, first.dataDir);
    const got = (await again.app.inject({ method: 'GET', url: '/api/templates' })).json();
    expect(got.templates[0]).toMatchObject({ name: '내 규격', bottom: [] });
    expect(got.templates[0].top[0]).toMatchObject({ name: 'seq', primaryKey: true });
    expect(got.defaultTemplateId).toBeNull();
  });
});
