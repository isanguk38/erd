// DB 반영 전 안전 검사 실행. 화면이 보낸 것은 검사 목록(종류·테이블·컬럼 이름)뿐이고 SQL은 여기서 만든다.
// 연결마다 읽기 전용 트랜잭션에서 SELECT COUNT만 실행하고 끝나면 되돌린다.

import { getDialect, safetySql, type DialectId, type SafetyCheck, type SafetyResult } from '@erd/core';

/** 검사 하나의 제한 시간 */
export const CHECK_TIMEOUT_MS = 15_000;
/** 전체 제한 시간 (넘으면 남은 검사는 건너뜀) */
const TOTAL_TIMEOUT_MS = 90_000;
const MAX_CHECKS = 300;

const KINDS = new Set(['rows', 'values', 'nulls', 'tooLong', 'notNumeric', 'duplicates', 'orphans', 'check']);
const str = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 512;

/** 받은 검사 목록이 모양이 맞는지 (이름만 받고 SQL은 받지 않는다) */
export function validateChecks(input: unknown): SafetyCheck[] {
  if (!Array.isArray(input)) throw new Error('검사 목록이 필요합니다');
  if (input.length > MAX_CHECKS) throw new Error(`검사가 너무 많습니다 (${MAX_CHECKS}개까지)`);
  return input.map((c) => {
    const x = c as Record<string, unknown>;
    const names = (v: unknown) => Array.isArray(v) && v.length > 0 && v.length <= 32 && v.every(str);
    const ok =
      x && str(x.id) && str(x.changeId) && str(x.table) && KINDS.has(x.kind as string) &&
      (!('column' in x) || str(x.column)) &&
      (!('columns' in x) || names(x.columns)) &&
      (x.kind !== 'orphans' || (str(x.parent) && names(x.parentColumns) && (x.parentColumns as unknown[]).length === (x.columns as unknown[]).length)) &&
      (x.kind !== 'tooLong' || (typeof x.length === 'number' && x.length >= 0)) &&
      (x.kind !== 'check' || (typeof x.expression === 'string' && x.expression.length <= 4000 && !x.expression.includes(';')));
    if (!ok) throw new Error('잘못된 검사 항목입니다');
    return x as unknown as SafetyCheck;
  });
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${Math.round(ms / 1000)}초 안에 끝나지 않았습니다 (데이터가 많은 테이블)`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/** 검사를 하나씩 실행한다. run은 SELECT COUNT 문장을 실행해 숫자를 돌려준다 (실패해도 다음 검사는 계속) */
export async function runSafetyChecks(dialect: DialectId, checks: SafetyCheck[], run: (sql: string) => Promise<number>): Promise<SafetyResult[]> {
  const d = getDialect(dialect);
  const started = Date.now();
  const results: SafetyResult[] = [];
  for (const check of checks) {
    if (Date.now() - started > TOTAL_TIMEOUT_MS) {
      results.push({ id: check.id, count: null, error: '전체 검사 시간이 길어 건너뛰었습니다' });
      continue;
    }
    try {
      const n = await withTimeout(run(safetySql(d, check)), CHECK_TIMEOUT_MS);
      results.push({ id: check.id, count: Number.isFinite(n) ? n : null });
    } catch (e) {
      results.push({ id: check.id, count: null, error: (e instanceof Error ? e.message : String(e)).split('\n')[0].slice(0, 300) });
    }
  }
  return results;
}

/** 첫 행의 n 값 (드라이버마다 이름 대소문자·숫자 형식이 다르다) */
export function countOf(rows: unknown[] | undefined): number {
  const row = (rows?.[0] ?? {}) as Record<string, unknown>;
  const v = row.n ?? row.N ?? Object.values(row)[0];
  return Number(v);
}
