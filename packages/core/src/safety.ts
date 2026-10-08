// DB 반영 전 안전 검사: DB로 내보낼 변경 중 지금 데이터 때문에 실패하거나 데이터가 사라지는 것을 미리 센다.
// 예) 길이를 줄이는데 더 긴 값, UNIQUE를 거는데 중복 값, NOT NULL로 바꾸는데 NULL인 행.
// 사람이 규칙을 넣지 않는다 — 변경 목록(diff)에서 검사할 것을 정하고, DB 종류별 SQL은 여기서 만든다.
// 검사는 읽기만 한다 (DB 연결 쪽이 읽기 전용 트랜잭션에서 SELECT COUNT만 실행). 건수는 SAFETY_CAP에서 멈춘다.

import type { Change } from './diff';
import type { Dialect } from './dialects/types';
import type { Column, Schema, Table } from './model';
import { findTable } from './model';

/** 이보다 많으면 "1,000건 이상"으로 (큰 테이블에서 끝까지 세지 않게) */
export const SAFETY_CAP = 1000;

export type SafetyCheck = { id: string; changeId: string; table: string } & (
  | { kind: 'rows' }
  | { kind: 'values'; column: string }
  | { kind: 'nulls'; column: string }
  | { kind: 'tooLong'; column: string; length: number }
  | { kind: 'notNumeric'; column: string; integer: boolean }
  | { kind: 'duplicates'; columns: string[] }
  | { kind: 'orphans'; columns: string[]; parent: string; parentColumns: string[] }
  | { kind: 'check'; expression: string }
);

/** id 없는 검사 (유니온 각각에서 id만 뺀다) */
type NewCheck = SafetyCheck extends infer T ? (T extends SafetyCheck ? Omit<T, 'id'> : never) : never;

export interface SafetyResult {
  id: string;
  /** 센 건수 (SAFETY_CAP + 1이면 그 이상). 검사하지 못했으면 null */
  count: number | null;
  error?: string;
}

const CHAR = /^(N?VARCHAR2?|N?CHAR|CHARACTER( VARYING)?|VARYING|TEXT|NTEXT|TINYTEXT|MEDIUMTEXT|LONGTEXT|CLOB|NCLOB|STRING)$/;
const INTEGER = /^(TINYINT|SMALLINT|MEDIUMINT|INT|INTEGER|BIGINT|INT2|INT4|INT8|SERIAL|BIGSERIAL|SMALLSERIAL)$/;
const DECIMAL = /^(DECIMAL|NUMERIC|NUMBER|FLOAT|DOUBLE|DOUBLE PRECISION|REAL|MONEY)$/;
const base = (c: Column) => c.type.trim().toUpperCase().replace(/\s+UNSIGNED$/, '').replace(/\s*\(.*$/, '');
/** 문자 타입의 최대 길이 (없거나 MAX면 무제한) */
const charLength = (c: Column): number => {
  if (/TEXT|CLOB/.test(base(c))) return Infinity;
  const n = parseInt(c.length, 10);
  return Number.isFinite(n) ? n : Infinity;
};
const effectiveNullable = (c: Column) => c.nullable && !c.primaryKey && !c.autoIncrement;

/**
 * 실행할 변경에서 데이터를 세어 볼 것들. db는 ERD id로 맞춘 DB 구조(plan.dbAligned) — DB에 실제 있는 이름으로 센다.
 * 새로 만드는 테이블·컬럼은 아직 데이터가 없으니 검사하지 않는다.
 */
export function safetyChecks(changes: Change[], db: Schema): SafetyCheck[] {
  const checks: SafetyCheck[] = [];
  const add = (c: NewCheck) => checks.push({ ...c, id: `${c.changeId}#${checks.length}` } as SafetyCheck);
  const dbTable = (id: string) => findTable(db, id);
  const dbColumn = (t: Table | undefined, id: string) => t?.columns.find((c) => c.id === id);
  for (const ch of changes) {
    switch (ch.kind) {
      case 'dropTable': {
        const t = dbTable(ch.table.id);
        if (t) add({ changeId: ch.id, table: t.name, kind: 'rows' });
        break;
      }
      case 'dropColumn': {
        const t = dbTable(ch.table.id);
        const c = dbColumn(t, ch.column.id);
        if (t && c) add({ changeId: ch.id, table: t.name, kind: 'values', column: c.name });
        break;
      }
      case 'addColumn': {
        const t = dbTable(ch.table.id);
        const c = ch.column;
        if (t && !effectiveNullable(c) && !c.defaultValue && !c.autoIncrement && !c.generated?.expression.trim()) add({ changeId: ch.id, table: t.name, kind: 'rows' });
        break;
      }
      case 'alterColumn': {
        const t = dbTable(ch.table.id);
        const c = dbColumn(t, ch.before.id);
        if (!t || !c) break;
        if (ch.fields.includes('nullable') && !effectiveNullable(ch.after)) add({ changeId: ch.id, table: t.name, kind: 'nulls', column: c.name });
        if (ch.fields.includes('type')) {
          const from = base(c);
          const to = base(ch.after);
          if (CHAR.test(from) && CHAR.test(to) && charLength(ch.after) < charLength(c)) add({ changeId: ch.id, table: t.name, kind: 'tooLong', column: c.name, length: charLength(ch.after) });
          else if (CHAR.test(from) && (INTEGER.test(to) || DECIMAL.test(to))) add({ changeId: ch.id, table: t.name, kind: 'notNumeric', column: c.name, integer: INTEGER.test(to) || (to === 'NUMBER' && !/,/.test(ch.after.length) && Boolean(ch.after.length)) });
        }
        break;
      }
      case 'primaryKey': {
        const t = dbTable(ch.after.id);
        const cols = ch.after.columns.filter((c) => c.primaryKey).map((c) => dbColumn(t, c.id));
        if (!t || !cols.length || cols.some((c) => !c)) break;
        add({ changeId: ch.id, table: t.name, kind: 'duplicates', columns: cols.map((c) => c!.name) });
        for (const c of cols) if (effectiveNullable(c!)) add({ changeId: ch.id, table: t.name, kind: 'nulls', column: c!.name });
        break;
      }
      case 'addIndex': {
        if (!ch.index.unique || ch.category !== 'alter' || ch.index.expression?.trim() || ch.index.where?.trim()) break;
        const t = dbTable(ch.table.id);
        const cols = ch.index.columnIds.map((id) => dbColumn(t, id));
        if (t && cols.length && cols.every(Boolean)) add({ changeId: ch.id, table: t.name, kind: 'duplicates', columns: cols.map((c) => c!.name) });
        break;
      }
      case 'addForeignKey': {
        const r = ch.relation;
        const child = dbTable(r.fromTableId);
        const parent = dbTable(r.toTableId);
        const cols = r.fromColumnIds.map((id) => dbColumn(child, id));
        const pcols = r.toColumnIds.map((id) => dbColumn(parent, id));
        if (child && parent && cols.length && cols.every(Boolean) && pcols.every(Boolean)) {
          add({ changeId: ch.id, table: child.name, kind: 'orphans', columns: cols.map((c) => c!.name), parent: parent.name, parentColumns: pcols.map((c) => c!.name) });
        }
        break;
      }
      case 'addCheck': {
        const t = ch.category === 'alter' ? dbTable(ch.table.id) : undefined;
        if (t && ch.check.expression.trim() && !ch.check.expression.includes(';')) add({ changeId: ch.id, table: t.name, kind: 'check', expression: ch.check.expression.trim() });
        break;
      }
    }
  }
  return checks;
}

const LENGTH_FN: Record<string, string> = { mysql: 'CHAR_LENGTH', mariadb: 'CHAR_LENGTH', postgresql: 'char_length', oracle: 'LENGTH', mssql: 'LEN' };

/** 조건에 맞는 행을 SAFETY_CAP + 1개까지만 세는 SQL */
function capped(dialect: Dialect, from: string, where: string): string {
  const n = SAFETY_CAP + 1;
  if (dialect.id === 'oracle') return `SELECT COUNT(*) AS n FROM (SELECT 1 AS x FROM ${from} WHERE (${where}) AND ROWNUM <= ${n})`;
  if (dialect.id === 'mssql') return `SELECT COUNT(*) AS n FROM (SELECT TOP ${n} 1 AS x FROM ${from} WHERE ${where}) t`;
  return `SELECT COUNT(*) AS n FROM (SELECT 1 AS x FROM ${from} WHERE ${where} LIMIT ${n}) t`;
}

function numericPattern(dialect: Dialect, col: string, integer: boolean): string {
  const re = `^[[:space:]]*-?[0-9]+${integer ? '' : '([.][0-9]+)?'}[[:space:]]*$`;
  switch (dialect.id) {
    case 'postgresql': return `${col} IS NOT NULL AND ${col}::text !~ '${re}'`;
    case 'oracle': return `${col} IS NOT NULL AND NOT REGEXP_LIKE(${col}, '${re}')`;
    case 'mssql': return `${col} IS NOT NULL AND TRY_CAST(${col} AS ${integer ? 'BIGINT' : 'DECIMAL(38,10)'}) IS NULL`;
    default: return `${col} IS NOT NULL AND ${col} NOT REGEXP '${re}'`;
  }
}

/** 검사 하나를 SELECT COUNT 문장으로 (이름은 DB 종류에 맞게 따옴표로 감싼다) */
export function safetySql(dialect: Dialect, check: SafetyCheck): string {
  const q = dialect.quote;
  const from = q(check.table);
  switch (check.kind) {
    case 'rows': return capped(dialect, from, '1 = 1');
    case 'values': return capped(dialect, from, `${q(check.column)} IS NOT NULL`);
    case 'nulls': return capped(dialect, from, `${q(check.column)} IS NULL`);
    case 'tooLong': return capped(dialect, from, `${LENGTH_FN[dialect.id] ?? 'LENGTH'}(${q(check.column)}) > ${Math.floor(check.length)}`);
    case 'notNumeric': return capped(dialect, from, numericPattern(dialect, q(check.column), check.integer));
    case 'check': {
      if (check.expression.includes(';')) throw new Error('CHECK 식에 ;를 쓸 수 없습니다');
      return capped(dialect, from, `NOT (${check.expression})`);
    }
    case 'orphans': {
      const own = check.columns.map((c) => `c.${q(c)} IS NOT NULL`).join(' AND ');
      const join = check.columns.map((c, i) => `p.${q(check.parentColumns[i])} = c.${q(c)}`).join(' AND ');
      return capped(dialect, `${from} c`, `${own} AND NOT EXISTS (SELECT 1 FROM ${q(check.parent)} p WHERE ${join})`);
    }
    case 'duplicates': {
      const cols = check.columns.map(q);
      const n = SAFETY_CAP + 1;
      const inner = `FROM ${from} WHERE ${cols.map((c) => `${c} IS NOT NULL`).join(' AND ')} GROUP BY ${cols.join(', ')} HAVING COUNT(*) > 1`;
      if (dialect.id === 'oracle') return `SELECT COUNT(*) AS n FROM (SELECT x FROM (SELECT 1 AS x ${inner}) WHERE ROWNUM <= ${n})`;
      if (dialect.id === 'mssql') return `SELECT COUNT(*) AS n FROM (SELECT TOP ${n} 1 AS x ${inner}) t`;
      return `SELECT COUNT(*) AS n FROM (SELECT 1 AS x ${inner} LIMIT ${n}) t`;
    }
  }
}

export interface SafetyFinding {
  /** fail: 이대로 실행하면 실패 / loss: 실행되지만 데이터가 사라짐 / unknown: 검사하지 못함 */
  level: 'fail' | 'loss' | 'unknown';
  text: string;
}

const countText = (n: number) => (n > SAFETY_CAP ? `${SAFETY_CAP.toLocaleString()}건 이상` : `${n.toLocaleString()}건`);

/** 검사 결과를 변경(change id)별 안내로. 문제가 없는 검사는 빠진다 */
export function safetyFindings(checks: SafetyCheck[], results: SafetyResult[]): Map<string, SafetyFinding[]> {
  const byId = new Map(results.map((r) => [r.id, r]));
  const out = new Map<string, SafetyFinding[]>();
  const push = (changeId: string, f: SafetyFinding) => out.set(changeId, [...(out.get(changeId) ?? []), f]);
  for (const c of checks) {
    const r = byId.get(c.id);
    if (!r) continue;
    if (r.count === null) {
      push(c.changeId, { level: 'unknown', text: `데이터를 검사하지 못했습니다${r.error ? `: ${r.error}` : ''}` });
      continue;
    }
    if (r.count <= 0) continue;
    const n = countText(r.count);
    switch (c.kind) {
      case 'rows':
        push(c.changeId, c.changeId.startsWith('dropTable:')
          ? { level: 'loss', text: `${c.table}에 데이터 ${n}이 있습니다 — 테이블과 함께 삭제됩니다` }
          : { level: 'fail', text: `${c.table}에 행이 ${n} 있어 기본값 없는 NOT NULL 컬럼 추가가 실패합니다 — 기본값을 넣거나, NULL 허용으로 추가해 값을 채운 뒤 NOT NULL로 바꾸세요` });
        break;
      case 'values': push(c.changeId, { level: 'loss', text: `${c.table}.${c.column}에 값이 있는 행 ${n} — 컬럼과 함께 삭제됩니다` }); break;
      case 'nulls': push(c.changeId, { level: 'fail', text: `${c.table}.${c.column}이(가) NULL인 행 ${n} — NOT NULL로 바꾸면 실패합니다 (먼저 값을 채우세요)` }); break;
      case 'tooLong': push(c.changeId, { level: 'fail', text: `${c.table}.${c.column}에 ${c.length}자보다 긴 값 ${n} — 실패하거나 잘립니다` }); break;
      case 'notNumeric': push(c.changeId, { level: 'fail', text: `${c.table}.${c.column}에 ${c.integer ? '정수' : '숫자'}로 바꿀 수 없는 값 ${n} — 타입 변경이 실패합니다` }); break;
      case 'duplicates': push(c.changeId, { level: 'fail', text: `${c.table}(${c.columns.join(', ')})에 중복 값 ${n.replace('건', '묶음')} — UNIQUE·기본키를 만들 수 없습니다` }); break;
      case 'orphans': push(c.changeId, { level: 'fail', text: `${c.table}(${c.columns.join(', ')})에 ${c.parent}에 없는 값 ${n} — 외래키를 만들 수 없습니다` }); break;
      case 'check': push(c.changeId, { level: 'fail', text: `${c.table}에 조건(${c.expression})에 맞지 않는 행 ${n} — CHECK 추가가 실패합니다` }); break;
    }
  }
  return out;
}
