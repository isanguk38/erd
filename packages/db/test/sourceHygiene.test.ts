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

  it('DB 이름으로 나누는 조건문은 DBMS 파일 안에만 있다 (공통 코드·화면은 기능 모듈이 있는지만 본다)', () => {
    // 예) if (dialect.id === 'postgresql') ... 대신 dialect.features.enum 이 있는지 본다
    const root = join(__dirname, '..', '..', '..');
    const DB = "'(mysql|mariadb|postgresql|oracle|mssql)'";
    const pattern = new RegExp(`(===|!==)\\s*${DB}|${DB}\\s*(===|!==)|case\\s+${DB}`);
    // DBMS별 코드가 사는 곳: core/src/dialects (DBMS 파일), db/src (DB별 연결 코드)
    const allowed = [join(root, 'packages/core/src/dialects'), join(root, 'packages/db/src')];
    const bad: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name === 'dist') continue;
        const p = join(dir, name);
        if (allowed.some((a) => p.startsWith(a))) continue;
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(name)) {
          readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
            if (pattern.test(line)) bad.push(`${p.slice(root.length + 1)}:${i + 1}: ${line.trim()}`);
          });
        }
      }
    };
    for (const dir of ['packages/core/src', 'packages/mcp/src', 'apps/server/src', 'apps/web/src', 'desktop/src']) walk(join(root, dir));
    expect(bad).toEqual([]);
  });

  it('검사가 실제로 제어 문자를 잡는다', () => {
    expect(CONTROL.test(`a${String.fromCharCode(8)}b`)).toBe(true);
    expect(CONTROL.test('a\\bb')).toBe(false);
  });
});
