// DB 가져오기·내보내기 기록을 저장하기 전에 다듬는다.
// 화면이 보낸 값을 그대로 믿지 않고, 오류 문장에 섞일 수 있는 비밀번호를 가리고 길이를 줄인다.

import type { DbLogEntry } from './projects';

const ACTIONS = new Set(['pull', 'push', 'seed']);
const STAGES = new Set(['compare', 'safety', 'execute', 'apply']);
const MAX_TEXT = 2000;
const MAX_SQL = 4000;
const MAX_RESULTS = 300;

/** 오류 문장의 접속 비밀번호를 가린다 (예: mysql://root:비밀번호@host, password=...) */
export function scrubSecret(text: string): string {
  return text
    .replace(/(\w+:\/\/[^:\s/@]+:)[^@\s]+@/g, '$1***@')
    .replace(/\b(password|passwd|pwd)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s;,]+)/gi, '$1$2***');
}

const str = (v: unknown, max = MAX_TEXT) => (typeof v === 'string' && v ? scrubSecret(v).slice(0, max) : undefined);

type Input = Partial<Record<keyof DbLogEntry, unknown>>;

/** 화면이 보낸 기록을 검사해 저장할 모양으로 만든다. 잘못된 값이면 이유를 던진다 */
export function cleanDbLog(body: Input, by: string | undefined, via: DbLogEntry['via']): Omit<DbLogEntry, 'id' | 'at'> {
  if (!ACTIONS.has(body.action as string)) throw new Error('action은 pull·push·seed 중 하나입니다');
  if (!STAGES.has(body.stage as string)) throw new Error('stage는 compare·safety·execute·apply 중 하나입니다');
  const c = (body.connection ?? {}) as Record<string, unknown>;
  const results = Array.isArray(body.results)
    ? body.results.slice(0, MAX_RESULTS).map((r: Record<string, unknown>) => ({
        sql: str(r?.sql, MAX_SQL) ?? '',
        ok: Boolean(r?.ok),
        ...(r?.skipped ? { skipped: true } : {}),
        ...(str(r?.error) ? { error: str(r?.error) } : {}),
      }))
    : undefined;
  const warnings = Array.isArray(body.warnings) ? body.warnings.slice(0, 50).map((w) => str(w)).filter((w): w is string => Boolean(w)) : undefined;
  return {
    by,
    action: body.action as DbLogEntry['action'],
    stage: body.stage as DbLogEntry['stage'],
    via,
    ok: Boolean(body.ok),
    connection: { name: str(c.name, 200) ?? '', dialect: str(c.dialect, 40) ?? '', database: str(c.database, 200) ?? '', ...(str(c.serverVersion, 200) ? { serverVersion: str(c.serverVersion, 200) } : {}) },
    ...(str(body.error) ? { error: str(body.error) } : {}),
    ...(results ? { results } : {}),
    ...(typeof body.rolledBack === 'boolean' ? { rolledBack: body.rolledBack } : {}),
    ...(typeof body.appliedCount === 'number' ? { appliedCount: body.appliedCount } : {}),
    ...(warnings?.length ? { warnings } : {}),
  };
}
