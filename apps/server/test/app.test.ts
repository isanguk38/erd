import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app';

const input = { name: '로컬', dialect: 'mysql', host: '127.0.0.1', port: 3306, user: 'root', database: 'shop', password: 's3cret' };

describe('연결 API', () => {
  it('비밀번호는 암호화해 저장하고 응답에는 넣지 않는다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'erd-'));
    const { app } = buildApp({ dataDir: dir });
    const created = (await app.inject({ method: 'POST', url: '/api/connections', payload: input })).json();
    expect(created).toMatchObject({ name: '로컬', hasPassword: true });
    expect(created.password).toBeUndefined();
    expect(created.passwordEnc).toBeUndefined();

    const file = readFileSync(join(dir, 'connections.json'), 'utf8');
    expect(file).not.toContain('s3cret');

    // 비밀번호 없이 수정하면 기존 비밀번호 유지
    const updated = (await app.inject({ method: 'PUT', url: `/api/connections/${created.id}`, payload: { ...input, name: '이름 변경', password: '' } })).json();
    expect(updated).toMatchObject({ name: '이름 변경', hasPassword: true });

    const list = (await app.inject({ method: 'GET', url: '/api/connections' })).json();
    expect(list).toHaveLength(1);
    await app.inject({ method: 'DELETE', url: `/api/connections/${created.id}` });
    expect((await app.inject({ method: 'GET', url: '/api/connections' })).json()).toEqual([]);
  });

  it('잘못된 입력과 접속 실패는 알아보기 쉬운 오류로 돌려준다', async () => {
    const { app } = buildApp({ dataDir: mkdtempSync(join(tmpdir(), 'erd-')) });
    const bad = await app.inject({ method: 'POST', url: '/api/connections', payload: { ...input, port: 'x' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('포트가 올바르지 않습니다');

    const refused = await app.inject({ method: 'POST', url: '/api/connections/test', payload: { ...input, port: 1 } });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toContain('DB 서버에 연결할 수 없습니다');
  });
});
