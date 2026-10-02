import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type ErdApp } from '../src/app';

const apps: ErdApp[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.app.close();
});

const release = {
  tag_name: 'v0.2.0',
  name: 'ERD 0.2.0',
  body: '- Oracle·SQL Server·MariaDB 연결\n- 연결이 끊겨도 앱이 멈추지 않음',
  html_url: 'https://github.com/isanguk38/erd/releases/tag/v0.2.0',
  published_at: '2026-10-02T00:00:00Z',
  draft: false,
  prerelease: false,
  assets: [
    { name: 'ERD-Setup-0.2.0.exe.blockmap', browser_download_url: 'https://example.invalid/blockmap' },
    { name: 'ERD-Setup-0.2.0.exe', browser_download_url: 'https://github.com/isanguk38/erd/releases/download/v0.2.0/ERD-Setup-0.2.0.exe' },
  ],
};

describe('설치형 앱 최신 버전 안내', () => {
  it('로그인 없이 최신 버전·변경 내용·설치 파일 주소를 알려 주고, GitHub 호출은 재사용한다', async () => {
    let calls = 0;
    const erd = buildApp({
      dataDir: mkdtempSync(join(tmpdir(), 'erd-desk-')),
      secret: 'test-secret',
      auth: { enabled: true, devLogin: true },
      fetchDesktopRelease: async () => {
        calls++;
        return release;
      },
    });
    apps.push(erd);
    const res = await erd.app.inject({ method: 'GET', url: '/api/desktop/latest' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      version: '0.2.0',
      notes: release.body,
      url: 'https://github.com/isanguk38/erd/releases/download/v0.2.0/ERD-Setup-0.2.0.exe',
    });
    await erd.app.inject({ method: 'GET', url: '/api/desktop/latest' });
    expect(calls).toBe(1);
  });

  it('GitHub에 닿지 않으면 503, 설치 파일이 없으면 404', async () => {
    const down = buildApp({ dataDir: mkdtempSync(join(tmpdir(), 'erd-desk-')), fetchDesktopRelease: async () => { throw new Error('offline'); } });
    const empty = buildApp({ dataDir: mkdtempSync(join(tmpdir(), 'erd-desk-')), fetchDesktopRelease: async () => ({ ...release, assets: [] }) });
    apps.push(down, empty);
    expect((await down.app.inject({ method: 'GET', url: '/api/desktop/latest' })).statusCode).toBe(503);
    expect((await empty.app.inject({ method: 'GET', url: '/api/desktop/latest' })).statusCode).toBe(404);
  });
});
