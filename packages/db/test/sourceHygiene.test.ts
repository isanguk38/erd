import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// 스크립트로 파일을 고치다 정규식의 \b가 백스페이스 문자로 바뀐 적이 있다 (PostgreSQL UNSIGNED 제거가 조용히 멈춤).
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;

describe('소스 파일', () => {
  it('보이지 않는 제어 문자(백스페이스 등)가 섞여 있지 않다', () => {
    const root = join(__dirname, '..', '..', '..');
    const bad: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name === 'dist') continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx|css)$/.test(name) && CONTROL.test(readFileSync(p, 'utf8'))) bad.push(p);
      }
    };
    for (const dir of ['packages/core/src', 'packages/db/src', 'packages/db/test', 'packages/mcp/src', 'apps/server/src', 'apps/web/src', 'desktop/src']) walk(join(root, dir));
    expect(bad).toEqual([]);
  });

  it('검사가 실제로 제어 문자를 잡는다', () => {
    expect(CONTROL.test(`a${String.fromCharCode(8)}b`)).toBe(true);
    expect(CONTROL.test('a\\bb')).toBe(false);
  });
});
