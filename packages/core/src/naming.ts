// 이름 표기 기준: 프로젝트의 테이블·컬럼 물리명을 snake_case / SNAKE_CASE / camelCase 중 하나로 맞춘다.
// 기준은 프로젝트 정보(meta.namingStyle)에 저장한다. 정하지 않았으면 지금 이름들로 판단한다 (가장 많이 맞는 표기).
// 설계 검사가 기준과 다른 이름을 알려 주고, AI도 이 기준을 읽어 같은 표기로 만든다.

import type { Schema } from './model';

/** snake: member_no / SNAKE: MEMBER_NO / camel: memberNo */
export type NameStyle = 'snake' | 'SNAKE' | 'camel';

export const NAME_STYLES: NameStyle[] = ['snake', 'SNAKE', 'camel'];
export const NAME_STYLE_LABEL: Record<NameStyle, string> = { snake: 'snake_case', SNAKE: 'SNAKE_CASE', camel: 'camelCase' };
export const NAME_STYLE_EXAMPLE: Record<NameStyle, string> = { snake: 'member_no', SNAKE: 'MEMBER_NO', camel: 'memberNo' };

const STYLE_RE: Record<NameStyle, RegExp> = {
  snake: /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/,
  SNAKE: /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/,
  camel: /^[a-z][a-z0-9]*([A-Z][a-z0-9]*)*$/,
};
const JOIN: Record<NameStyle, (words: string[]) => string> = {
  snake: (w) => w.join('_').toLowerCase(),
  SNAKE: (w) => w.join('_').toUpperCase(),
  camel: (w) => w.map((x, i) => (i ? x[0].toUpperCase() + x.slice(1).toLowerCase() : x.toLowerCase())).join(''),
};

export function isNameStyle(v: unknown): v is NameStyle {
  return v === 'snake' || v === 'SNAKE' || v === 'camel';
}

/** 이 이름이 그 표기에 맞는지. 한 단어(price)는 snake·camel 둘 다 맞는다 */
export function fitsStyle(name: string, style: NameStyle): boolean {
  return STYLE_RE[style].test(name.trim());
}

/** 낱말로 나눠 그 표기로 (memberNo → member_no, MEMBER_NO → memberNo) */
export function toStyle(name: string, style: NameStyle): string {
  const words = name.trim().split(/[_\s-]+/).flatMap((w) => w.split(/(?<=[a-z0-9])(?=[A-Z])/)).filter(Boolean);
  return words.length ? JOIN[style](words) : name;
}

/** 지금 이름들로 판단한 표기 (이름이 없으면 null). 가장 많은 이름이 맞는 표기, 같으면 snake → SNAKE → camel */
export function detectNamingStyle(schema: Pick<Schema, 'tables'>): NameStyle | null {
  const names = schema.tables.flatMap((t) => [t.name, ...t.columns.map((c) => c.name)]).filter((n) => n.trim());
  if (!names.length) return null;
  const fits = NAME_STYLES.map((s) => names.filter((n) => fitsStyle(n, s)).length);
  const best = Math.max(...fits);
  return best ? NAME_STYLES[fits.indexOf(best)] : null;
}

/** 프로젝트의 표기 기준: 저장한 값, 없으면 지금 이름들로 판단 (auto) */
export function projectNamingStyle(saved: unknown, schema: Pick<Schema, 'tables'>): { style: NameStyle | null; auto: boolean } {
  if (isNameStyle(saved)) return { style: saved, auto: false };
  return { style: detectNamingStyle(schema), auto: true };
}

export interface NamingIssue {
  tableId: string;
  table: string;
  columnId?: string;
  column?: string;
  /** 지금 이름 */
  name: string;
  /** 기준대로 바꾼 이름 (기준에 맞게 바꿀 수 없으면 없음 — 한글 이름 등) */
  suggestion?: string;
}

/** 기준과 다른 테이블·컬럼 이름 */
export function namingIssues(schema: Pick<Schema, 'tables'>, style: NameStyle): NamingIssue[] {
  const out: NamingIssue[] = [];
  const suggest = (name: string) => {
    const s = toStyle(name, style);
    return s !== name && fitsStyle(s, style) ? s : undefined;
  };
  for (const t of schema.tables) {
    if (t.name.trim() && !fitsStyle(t.name, style)) out.push({ tableId: t.id, table: t.name, name: t.name, suggestion: suggest(t.name) });
    for (const c of t.columns) {
      if (c.name.trim() && !fitsStyle(c.name, style)) out.push({ tableId: t.id, table: t.name, columnId: c.id, column: c.name, name: c.name, suggestion: suggest(c.name) });
    }
  }
  return out;
}

/**
 * 바꾸기 전·후를 비교해 이번에 새로 만들거나 이름을 바꾼 테이블·컬럼 중 기준과 다른 것 (AI 편집 결과에 붙인다)
 */
export function namingNotes(before: Pick<Schema, 'tables'>, after: Pick<Schema, 'tables'>, style: NameStyle | null, limit = 30): string[] {
  if (!style) return [];
  const prevTables = new Map(before.tables.map((t) => [t.id, t.name] as const));
  const prevColumns = new Map(before.tables.flatMap((t) => t.columns.map((c) => [c.id, c.name] as const)));
  const label = NAME_STYLE_LABEL[style];
  const out: string[] = [];
  for (const i of namingIssues(after, style)) {
    const changed = i.columnId ? prevColumns.get(i.columnId) !== i.name : prevTables.get(i.tableId) !== i.name;
    if (!changed) continue;
    const where = i.columnId ? `${i.table}.${i.column}` : `테이블 ${i.table}`;
    out.push(`${where}: 이 프로젝트는 ${label} 기준입니다${i.suggestion ? ` — ${i.suggestion}(으)로 바꾸세요` : ''}`);
  }
  return out.length > limit ? [...out.slice(0, limit), `… 외 ${out.length - limit}개`] : out;
}
