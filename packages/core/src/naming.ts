// 이름 표기 기준: 프로젝트의 테이블·컬럼 물리명을 snake_case / SNAKE_CASE / camelCase 중 하나로 맞춘다.
// 테이블과 컬럼은 따로 정할 수 있다 (예: 테이블 camelCase, 컬럼 snake_case).
// 기준은 프로젝트 정보(meta.namingStyle)에 저장한다. 정하지 않은 쪽은 용어 사전의 표기, 사전도 없으면 지금 이름들로 판단한다 (가장 많이 맞는 표기).
// 설계 검사가 기준과 다른 이름을 알려 주고, AI도 이 기준을 읽어 같은 표기로 만든다.

import type { Schema } from './model';

/** snake: member_no / SNAKE: MEMBER_NO / camel: memberNo */
export type NameStyle = 'snake' | 'SNAKE' | 'camel';
/** 테이블 이름 / 컬럼 이름 */
export type NameKind = 'table' | 'column';

export const NAME_STYLES: NameStyle[] = ['snake', 'SNAKE', 'camel'];
export const NAME_KINDS: NameKind[] = ['table', 'column'];
export const NAME_STYLE_LABEL: Record<NameStyle, string> = { snake: 'snake_case', SNAKE: 'SNAKE_CASE', camel: 'camelCase' };
export const NAME_STYLE_EXAMPLE: Record<NameStyle, string> = { snake: 'member_no', SNAKE: 'MEMBER_NO', camel: 'memberNo' };
export const NAME_KIND_LABEL: Record<NameKind, string> = { table: '테이블', column: '컬럼' };

/** 저장한 기준: 테이블·컬럼 따로 (null이면 그쪽은 자동) */
export interface NamingSetting {
  table: NameStyle | null;
  column: NameStyle | null;
}
/** 종류별 표기 (판단한 것 포함) */
export type NamingStyles = Record<NameKind, NameStyle | null>;

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

/**
 * 저장된 값을 기준으로 읽는다. 예전 값(문자열 하나)은 테이블·컬럼 모두 그 표기.
 * 둘 다 정하지 않았으면 null
 */
export function readNamingSetting(v: unknown): NamingSetting | null {
  if (isNameStyle(v)) return { table: v, column: v };
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const setting = { table: isNameStyle(o.table) ? o.table : null, column: isNameStyle(o.column) ? o.column : null };
  return setting.table || setting.column ? setting : null;
}

/** 저장할 값: 둘이 같으면 문자열 하나, 다르면 { table, column }, 둘 다 없으면 null */
export function namingSettingValue(setting: NamingSetting | null | undefined): NameStyle | NamingSetting | null {
  if (!setting || (!setting.table && !setting.column)) return null;
  return setting.table === setting.column ? setting.table : { table: setting.table, column: setting.column };
}

export const sameNamingSetting = (a: NamingSetting | null | undefined, b: NamingSetting | null | undefined) =>
  (a?.table ?? null) === (b?.table ?? null) && (a?.column ?? null) === (b?.column ?? null);

/** 이 이름이 그 표기에 맞는지. 한 단어(price)는 snake·camel 둘 다 맞는다 */
export function fitsStyle(name: string, style: NameStyle): boolean {
  return STYLE_RE[style].test(name.trim());
}

/** 낱말로 나눠 그 표기로 (memberNo → member_no, MEMBER_NO → memberNo) */
export function toStyle(name: string, style: NameStyle): string {
  const words = name.trim().split(/[_\s-]+/).flatMap((w) => w.split(/(?<=[a-z0-9])(?=[A-Z])/)).filter(Boolean);
  return words.length ? JOIN[style](words) : name;
}

/** 이름들 중 가장 많이 맞는 표기 (같으면 snake → SNAKE → camel). 이름이 없거나 아무것도 안 맞으면 null */
export function detectStyleOf(names: string[]): NameStyle | null {
  const list = names.filter((n) => n.trim());
  if (!list.length) return null;
  const fits = NAME_STYLES.map((s) => list.filter((n) => fitsStyle(n, s)).length);
  const best = Math.max(...fits);
  return best ? NAME_STYLES[fits.indexOf(best)] : null;
}

const namesOf = (schema: Pick<Schema, 'tables'>, kind: NameKind) =>
  kind === 'table' ? schema.tables.map((t) => t.name) : schema.tables.flatMap((t) => t.columns.map((c) => c.name));

/** 지금 이름들로 판단한 표기 (테이블 이름끼리, 컬럼 이름끼리) */
export function detectNamingStyles(schema: Pick<Schema, 'tables'>): NamingStyles {
  return { table: detectStyleOf(namesOf(schema, 'table')), column: detectStyleOf(namesOf(schema, 'column')) };
}

export interface ResolvedNamingStyle {
  style: NameStyle | null;
  /** 저장한 기준이 아니라 판단한 것 */
  auto: boolean;
  /** 어디서 정했는지 (배지·안내에 보인다) */
  from: 'saved' | 'dictionary' | 'names';
}

/**
 * 프로젝트의 표기 기준 (테이블·컬럼 따로): 저장한 값 → 용어 사전의 표기 → 지금 이름들로 판단 (뒤의 둘은 auto)
 */
export function projectNamingStyles(
  saved: unknown,
  schema: Pick<Schema, 'tables'>,
  dictionaryStyles?: Partial<NamingStyles> | null,
): Record<NameKind, ResolvedNamingStyle> {
  const setting = readNamingSetting(saved);
  const resolve = (kind: NameKind): ResolvedNamingStyle => {
    const s = setting?.[kind];
    if (s) return { style: s, auto: false, from: 'saved' };
    const d = dictionaryStyles?.[kind];
    if (d) return { style: d, auto: true, from: 'dictionary' };
    return { style: detectStyleOf(namesOf(schema, kind)), auto: true, from: 'names' };
  };
  return { table: resolve('table'), column: resolve('column') };
}

/** 종류별 표기만 */
export const stylesOf = (r: Record<NameKind, ResolvedNamingStyle>): NamingStyles => ({ table: r.table.style, column: r.column.style });

/** 사람에게 보일 기준: 같으면 "snake_case", 다르면 "테이블 camelCase · 컬럼 snake_case" */
export function describeNaming(styles: Partial<NamingStyles>): string {
  const t = styles.table ? NAME_STYLE_LABEL[styles.table] : '-';
  const c = styles.column ? NAME_STYLE_LABEL[styles.column] : '-';
  return styles.table === styles.column ? t : `테이블 ${t} · 컬럼 ${c}`;
}

/** "이 프로젝트는 ○○ 기준입니다"의 ○○ (테이블·컬럼이 다르면 어느 쪽인지 붙인다) */
export function namingRuleText(styles: Partial<NamingStyles>, kind: NameKind): string {
  const s = styles[kind];
  if (!s) return '';
  return styles.table === styles.column ? NAME_STYLE_LABEL[s] : `${NAME_KIND_LABEL[kind]} 이름 ${NAME_STYLE_LABEL[s]}`;
}

/** 표기 하나(테이블·컬럼 모두)도 받는다 */
const asStyles = (s: Partial<NamingStyles> | NameStyle | null | undefined): Partial<NamingStyles> => (isNameStyle(s) ? { table: s, column: s } : (s ?? {}));

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

/** 기준과 다른 테이블·컬럼 이름 (기준이 없는 쪽은 보지 않는다) */
export function namingIssues(schema: Pick<Schema, 'tables'>, input: Partial<NamingStyles> | NameStyle | null): NamingIssue[] {
  const styles = asStyles(input);
  const out: NamingIssue[] = [];
  const suggest = (name: string, style: NameStyle) => {
    const s = toStyle(name, style);
    return s !== name && fitsStyle(s, style) ? s : undefined;
  };
  const { table: ts, column: cs } = styles;
  for (const t of schema.tables) {
    if (ts && t.name.trim() && !fitsStyle(t.name, ts)) out.push({ tableId: t.id, table: t.name, name: t.name, suggestion: suggest(t.name, ts) });
    if (!cs) continue;
    for (const c of t.columns) {
      if (c.name.trim() && !fitsStyle(c.name, cs)) out.push({ tableId: t.id, table: t.name, columnId: c.id, column: c.name, name: c.name, suggestion: suggest(c.name, cs) });
    }
  }
  return out;
}

/**
 * 바꾸기 전·후를 비교해 이번에 새로 만들거나 이름을 바꾼 테이블·컬럼 중 기준과 다른 것 (AI 편집 결과에 붙인다)
 */
export function namingNotes(before: Pick<Schema, 'tables'>, after: Pick<Schema, 'tables'>, input: Partial<NamingStyles> | NameStyle | null, limit = 30): string[] {
  const styles = asStyles(input);
  if (!styles.table && !styles.column) return [];
  const prevTables = new Map(before.tables.map((t) => [t.id, t.name] as const));
  const prevColumns = new Map(before.tables.flatMap((t) => t.columns.map((c) => [c.id, c.name] as const)));
  const out: string[] = [];
  for (const i of namingIssues(after, styles)) {
    const changed = i.columnId ? prevColumns.get(i.columnId) !== i.name : prevTables.get(i.tableId) !== i.name;
    if (!changed) continue;
    const kind: NameKind = i.columnId ? 'column' : 'table';
    const where = i.columnId ? `${i.table}.${i.column}` : `테이블 ${i.table}`;
    out.push(`${where}: 이 프로젝트는 ${namingRuleText(styles, kind)} 기준입니다${i.suggestion ? ` — ${i.suggestion}(으)로 바꾸세요` : ''}`);
  }
  return out.length > limit ? [...out.slice(0, limit), `… 외 ${out.length - limit}개`] : out;
}
