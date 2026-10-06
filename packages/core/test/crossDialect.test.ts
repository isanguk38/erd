import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { applyCommands, diffSchemas, emptySchema, generateStatements, getDialect, type DialectId, type Schema } from '../src';

/** MySQL로 설계한 ERD */
function mysqlDesign(): Schema {
  return applyCommands(emptySchema(), [
    { op: 'createTable', name: 'member', columns: [
      { name: 'member_id', type: 'BIGINT', primaryKey: true },
      { name: 'point', type: 'INT UNSIGNED', nullable: false, default: '0' },
      { name: 'price', type: 'DECIMAL UNSIGNED', length: '10,2' },
      { name: 'profile', type: 'JSON' },
      { name: 'ordered_at', type: 'DATETIME' },
      { name: 'doubled', type: 'INT', generated: '`point` * 2', generatedStored: true },
    ] },
    { op: 'addCheck', table: 'member', name: 'ck_point', expression: '`point` >= 0' },
    { op: 'addIndex', table: 'member', name: 'ix_desc', expression: '`member_id`, `ordered_at` DESC' },
    { op: 'addIndex', table: 'member', name: 'ix_city', expression: "(CAST(profile->>'$.city' AS CHAR(30)))" },
  ]).schema;
}
const out = (dialect: DialectId) => {
  const d = getDialect(dialect);
  const diff = diffSchemas(emptySchema(), mysqlDesign(), d);
  return { diff, sql: generateStatements(diff, d).map((s) => s.sql).join('\n') };
};

describe('MySQL로 설계한 ERD를 다른 DB로 내보낼 때', () => {
  it('PostgreSQL: UNSIGNED는 빼고, 백틱 이름은 PostgreSQL 표기로', () => {
    const { sql } = out('postgresql');
    expect(sql).toContain('point INTEGER NOT NULL DEFAULT 0');
    expect(sql).toContain('price NUMERIC(10,2)');
    expect(sql).not.toContain('UNSIGNED');
    expect(sql).not.toContain('`');
    expect(sql).toContain('CHECK (point >= 0)');
    expect(sql).toContain('ON member (member_id, ordered_at DESC)');
    expect(sql).toContain('GENERATED ALWAYS AS (point * 2) STORED');
  });

  it('SQL Server는 [이름], Oracle은 "이름"', () => {
    expect(out('mssql').sql).toContain('[doubled] AS ([point] * 2) PERSISTED');
    expect(out('oracle').sql).toMatch(/GENERATED ALWAYS AS \("?POINT"? \* 2\) VIRTUAL/i);
    expect(out('mssql').sql).not.toContain('`');
  });

  it('MySQL JSON 경로 문법은 다른 DB에서 주의를 단다', () => {
    const city = out('postgresql').diff.changes.find((c) => c.kind === 'addIndex' && (c as { index: { name: string } }).index.name === 'ix_city')!;
    expect(city.warning).toContain('MySQL JSON 경로');
    const mysqlCity = out('mysql').diff.changes.find((c) => c.kind === 'addIndex' && (c as { index: { name: string } }).index.name === 'ix_city')!;
    expect(mysqlCity.warning).toBeUndefined();
  });
});

describe('소스 파일', () => {
  it('보이지 않는 제어 문자(백스페이스 등)가 섞여 있지 않다', () => {
    const bad: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(name) && /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(readFileSync(p, 'utf8'))) bad.push(p);
      }
    };
    for (const dir of ['../core/src', '../db/src', '../mcp/src', '../../apps/server/src', '../../apps/web/src']) walk(join(__dirname, '..', dir));
    expect(bad).toEqual([]);
  });
});
