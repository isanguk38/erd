// 표준 용어 사전: 논리명(한글) → 표준 물리명·타입·길이. 예) 회원번호 → MBR_NO VARCHAR(20).
// 사전에 있는 용어만 쓴다 (단어를 이어 붙여 이름을 만들지 않는다 — 나누는 방법이 여러 가지라 생각과 다른 이름이 나올 수 있다).
// ERD 구조(스키마)와 따로 문서의 'dictionary' 맵에 둔다 — SQL·비교·DB 동기화·버전에는 영향이 없다.
// 사전이 없으면 아무 검사도 하지 않는다.

import * as Y from 'yjs';
import type { Column } from './model';

export interface DictTerm {
  /** 논리명 (예: 회원번호) */
  logical: string;
  /** 물리명 (예: MBR_NO) */
  physical: string;
  /** 타입 (예: VARCHAR). 비우면 타입은 검사하지 않는다 */
  type?: string;
  length?: string;
  description?: string;
}

/** 물리명을 채울 때 표기: 사전 그대로 / snake_case (mbr_no) / SNAKE_CASE (MBR_NO) / camelCase (mbrNo) */
export type DictCase = 'asis' | 'lower' | 'upper' | 'camel';

export interface Dictionary {
  terms: DictTerm[];
  case: DictCase;
  updatedAt?: string;
}

export function emptyDictionary(): Dictionary {
  return { terms: [], case: 'asis' };
}

/** 같은 용어인지 볼 때 쓰는 키 (띄어쓰기·대소문자 무시) */
export const dictKey = (s: string) => s.replace(/\s+/g, '').toLowerCase();

function dictMap(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap('dictionary');
}

function termsMap(doc: Y.Doc): Y.Map<unknown> {
  const root = dictMap(doc);
  let m = root.get('terms') as Y.Map<unknown> | undefined;
  if (!m) {
    m = new Y.Map();
    root.set('terms', m);
  }
  return m;
}

/** 사전 (용어가 하나도 없으면 null) */
export function readDictionary(doc: Y.Doc): Dictionary | null {
  const root = dictMap(doc);
  const terms = [...(((root.get('terms') as Y.Map<DictTerm> | undefined)?.values()) ?? [])].map((t) => ({ ...t }));
  if (!terms.length) return null;
  terms.sort((a, b) => a.logical.localeCompare(b.logical));
  return { terms, case: (root.get('case') as DictCase) ?? 'asis', updatedAt: (root.get('updatedAt') as string | undefined) ?? undefined };
}

/** 물리명 표기 설정 (사전이 비어 있어도 프로젝트에 남는다) */
export function readDictCase(doc: Y.Doc): DictCase {
  return (dictMap(doc).get('case') as DictCase | undefined) ?? 'asis';
}

const cleanTerm = (t: DictTerm): DictTerm | null => {
  const logical = t.logical?.trim();
  const physical = t.physical?.trim();
  if (!logical || !physical) return null;
  const out: DictTerm = { logical, physical };
  if (t.type?.trim()) out.type = t.type.trim().toUpperCase();
  if (t.length?.toString().trim()) out.length = t.length.toString().trim();
  if (t.description?.trim()) out.description = t.description.trim();
  return out;
};

/** 엑셀 등에서 읽은 용어를 넣는다. replace면 기존 용어를 지우고, merge면 같은 논리명만 덮어쓴다. 넣은 수 */
export function writeDictionary(doc: Y.Doc, input: { terms: DictTerm[]; case?: DictCase }, mode: 'replace' | 'merge' = 'replace'): number {
  const terms = termsMap(doc);
  if (mode === 'replace') terms.clear();
  let n = 0;
  for (const raw of input.terms) {
    const term = cleanTerm(raw);
    if (!term) continue;
    terms.set(dictKey(term.logical), term);
    n++;
  }
  if (input.case) dictMap(doc).set('case', input.case);
  dictMap(doc).set('updatedAt', new Date().toISOString());
  return n;
}

/** 용어 하나 넣기(같은 논리명이면 바꾸기). 논리명을 바꿨으면 previous에 옛 논리명 */
export function setDictEntry(doc: Y.Doc, entry: DictTerm, previous?: string): void {
  const clean = cleanTerm(entry);
  if (!clean) throw new Error('논리명과 물리명을 모두 입력하세요');
  const map = termsMap(doc);
  if (previous && dictKey(previous) !== dictKey(clean.logical)) map.delete(dictKey(previous));
  map.set(dictKey(clean.logical), clean);
  dictMap(doc).set('updatedAt', new Date().toISOString());
}

export function removeDictEntry(doc: Y.Doc, logical: string): void {
  termsMap(doc).delete(dictKey(logical));
}

export function setDictCase(doc: Y.Doc, value: DictCase): void {
  dictMap(doc).set('case', value);
}

export function clearDictionary(doc: Y.Doc): void {
  termsMap(doc).clear();
  // 예전에 넣은 표준 단어가 남아 있으면 함께 지운다 (지금은 쓰지 않음)
  dictMap(doc).delete('words');
  dictMap(doc).delete('updatedAt');
}

// ── 찾기 ──────────────────────────────────────────

export interface DictMatch {
  /** 표기 설정을 적용한 물리명 */
  physical: string;
  type?: string;
  length?: string;
  description?: string;
}

export function applyDictCase(name: string, c: DictCase): string {
  if (c === 'asis') return name;
  // 밑줄·공백·대문자 경계로 낱말을 나눈다 (MBR_NO, mbr_no, MbrNo, mbrNo → mbr, no)
  const parts = name.split(/[_\s-]+/).flatMap((w) => w.split(/(?<=[a-z0-9])(?=[A-Z])/)).filter(Boolean);
  if (c === 'camel') return parts.map((w, i) => (i ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase())).join('');
  const snake = parts.join('_');
  return c === 'lower' ? snake.toLowerCase() : snake.toUpperCase();
}

/** 물리명 비교·찾기용 키: 대소문자와 밑줄을 무시 (MBR_NO = mbrNo) */
const physicalKey = (name: string) => name.trim().toLowerCase().replace(/_/g, '');

/** 큰 사전에서 여러 번 찾을 때 쓰는 색인 (사전이 바뀔 때만 다시 만든다) */
export interface DictIndex {
  dict: Dictionary;
  terms: Map<string, DictTerm>;
  /** 물리명(대소문자·밑줄 무시) → 용어 */
  byPhysical: Map<string, DictTerm>;
}

const indexCache = new WeakMap<Dictionary, DictIndex>();

export function dictIndex(dict: Dictionary): DictIndex {
  const cached = indexCache.get(dict);
  if (cached) return cached;
  const terms = new Map(dict.terms.map((t) => [dictKey(t.logical), t]));
  const byPhysical = new Map<string, DictTerm>();
  for (const t of dict.terms) if (!byPhysical.has(physicalKey(t.physical))) byPhysical.set(physicalKey(t.physical), t);
  const index = { dict, terms, byPhysical };
  indexCache.set(dict, index);
  return index;
}

/** 논리명으로 표준 용어 찾기 (없으면 null) */
export function lookupTerm(dict: Dictionary | DictIndex | null | undefined, logical: string): DictMatch | null {
  if (!dict || !logical.trim()) return null;
  const index = 'byPhysical' in dict ? dict : dictIndex(dict);
  const term = index.terms.get(dictKey(logical));
  if (!term) return null;
  return {
    physical: applyDictCase(term.physical, index.dict.case),
    ...(term.type ? { type: term.type } : {}),
    ...(term.length ? { length: term.length } : {}),
    ...(term.description ? { description: term.description } : {}),
  };
}

/** 물리명으로 용어 찾기 (논리명이 빈 컬럼을 채울 때) */
export function lookupPhysical(dict: Dictionary | DictIndex | null | undefined, physical: string): DictTerm | null {
  if (!dict || !physical.trim()) return null;
  const index = 'byPhysical' in dict ? dict : dictIndex(dict);
  return index.byPhysical.get(physicalKey(physical)) ?? null;
}

/** 사전 안에서 찾기 (논리명·물리명·설명에 글자가 들어 있는 것) */
export function searchDictionary(entries: DictTerm[], query: string, limit = 200): DictTerm[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries.slice(0, limit);
  const qk = dictKey(q);
  const out: DictTerm[] = [];
  for (const e of entries) {
    if (dictKey(e.logical).includes(qk) || e.physical.toLowerCase().includes(q) || (e.description ?? '').toLowerCase().includes(q)) out.push(e);
    if (out.length >= limit) break;
  }
  return out;
}

const SAME_BASE: Record<string, string> = { INTEGER: 'INT', INT4: 'INT', INT8: 'BIGINT', VARCHAR2: 'VARCHAR', NVARCHAR2: 'NVARCHAR', BOOL: 'BOOLEAN', 'CHARACTER VARYING': 'VARCHAR' };
const baseType = (t: string) => {
  const up = t.trim().toUpperCase().replace(/\s+/g, ' ');
  return SAME_BASE[up] ?? up;
};

/** 사전의 타입 표기 "VARCHAR(20)"을 타입과 길이로 */
export function splitDictType(type: string | undefined, length?: string): { type?: string; length?: string } {
  if (!type?.trim()) return { length: length?.trim() || undefined };
  const m = type.trim().match(/^([^()]+?)\s*\(\s*([^)]*)\)\s*$/);
  if (m) return { type: m[1].trim().toUpperCase(), length: length?.trim() || m[2].replace(/\s+/g, '') };
  return { type: type.trim().toUpperCase(), length: length?.trim() || undefined };
}

export interface ColumnDictCheck {
  status: 'ok' | 'mismatch' | 'unknown';
  match?: DictMatch;
  /** 다른 점 (예: '물리명 MBR_NO', '타입 VARCHAR(20)') */
  diffs: string[];
  /** 표준대로 바꾸는 값 */
  patch?: Partial<Column>;
}

/** 컬럼이 사전을 따르는지. 논리명이 없으면 null (논리명 없음은 설계 검사가 따로 알린다) */
export function checkColumnAgainstDictionary(dict: Dictionary | DictIndex | null | undefined, column: Pick<Column, 'name' | 'logicalName' | 'type' | 'length'>): ColumnDictCheck | null {
  if (!dict || !column.logicalName.trim()) return null;
  const match = lookupTerm(dict, column.logicalName);
  if (!match) return { status: 'unknown', diffs: [] };
  const diffs: string[] = [];
  const patch: Partial<Column> = {};
  if (match.physical.toLowerCase() !== column.name.trim().toLowerCase()) {
    diffs.push(`물리명 ${match.physical}`);
    patch.name = match.physical;
  }
  if (match.type) {
    const want = splitDictType(match.type, match.length);
    const typeDiff = baseType(want.type ?? '') !== baseType(column.type);
    const lengthDiff = want.length !== undefined && want.length.replace(/\s+/g, '') !== column.length.replace(/\s+/g, '');
    if (typeDiff || lengthDiff) {
      diffs.push(`타입 ${want.type}${want.length ? `(${want.length})` : ''}`);
      if (want.type) patch.type = want.type;
      patch.length = want.length ?? (typeDiff ? '' : column.length);
    }
  }
  return diffs.length ? { status: 'mismatch', match, diffs, patch } : { status: 'ok', match, diffs };
}

/** 표준대로 채울 값 (논리명을 입력했을 때): 물리명, 사전에 타입이 있으면 타입·길이 */
export function dictionaryPatch(match: DictMatch): Partial<Column> {
  const patch: Partial<Column> = { name: match.physical };
  if (match.type) {
    const t = splitDictType(match.type, match.length);
    if (t.type) patch.type = t.type;
    patch.length = t.length ?? '';
  }
  return patch;
}

/** 표준을 사람이 읽는 글로 (예: "MBR_NO VARCHAR(20)") */
export function describeMatch(match: DictMatch): string {
  const t = match.type ? splitDictType(match.type, match.length) : null;
  return `${match.physical}${t?.type ? ` ${t.type}${t.length ? `(${t.length})` : ''}` : ''}`;
}

/**
 * 이번에 새로 만들거나 고친 컬럼 중 사전과 다른 것 (AI 편집 결과에 붙인다).
 * 사전이 없으면 빈 배열.
 */
export function dictionaryNotes(dict: Dictionary | null | undefined, before: { tables: { id: string; columns: Column[] }[] }, after: { tables: { id: string; name: string; columns: Column[] }[] }, limit = 30): string[] {
  if (!dict?.terms.length) return [];
  const index = dictIndex(dict);
  const prev = new Map(before.tables.flatMap((t) => t.columns.map((c) => [c.id, c] as const)));
  const out: string[] = [];
  for (const t of after.tables) {
    for (const c of t.columns) {
      const old = prev.get(c.id);
      if (old && old.name === c.name && old.logicalName === c.logicalName && old.type === c.type && old.length === c.length) continue;
      const r = checkColumnAgainstDictionary(index, c);
      if (!r || r.status === 'ok') continue;
      out.push(
        r.status === 'mismatch'
          ? `${t.name}.${c.name}: "${c.logicalName}"의 표준은 ${describeMatch(r.match!)} — updateColumn으로 맞추세요`
          : `${t.name}.${c.name}: "${c.logicalName}"은(는) 표준 용어 사전에 없습니다 — lookup_dictionary로 비슷한 표준 용어를 찾거나 사용자에게 확인하세요`,
      );
    }
  }
  return out.length > limit ? [...out.slice(0, limit), `… 외 ${out.length - limit}개`] : out;
}

// ── ERD에서 사전 만들기 ──────────────────────────────

export interface DictVariant {
  physical: string;
  type: string;
  length: string;
  /** 이 이름·타입을 쓰는 곳 (테이블.컬럼) */
  columns: string[];
}

/** 같은 논리명인데 물리명·타입·길이가 다른 것 */
export interface DictConflict {
  logical: string;
  /** 많이 쓰는 순. 첫 번째가 사전에 들어간 것 */
  variants: DictVariant[];
}

/**
 * 지금 ERD의 컬럼으로 사전 초안을 만든다: 논리명이 같은 컬럼을 묶어 가장 많이 쓰는 물리명·타입·길이를 용어로.
 * 논리명이 같은데 이름·타입이 섞여 있으면 충돌로 따로 알려 준다 (사전에는 가장 많이 쓰는 것이 들어감).
 */
export function dictionaryFromSchema(schema: { tables: { name: string; columns: Column[] }[] }): { terms: DictTerm[]; conflicts: DictConflict[]; skipped: number } {
  const groups = new Map<string, { logicals: Map<string, number>; comments: Map<string, number>; variants: Map<string, DictVariant> }>();
  let skipped = 0;
  for (const t of schema.tables) {
    for (const c of t.columns) {
      const logical = c.logicalName.trim();
      if (!logical) {
        skipped++;
        continue;
      }
      const key = dictKey(logical);
      const g = groups.get(key) ?? { logicals: new Map(), comments: new Map(), variants: new Map() };
      groups.set(key, g);
      g.logicals.set(logical, (g.logicals.get(logical) ?? 0) + 1);
      if (c.comment.trim()) g.comments.set(c.comment.trim(), (g.comments.get(c.comment.trim()) ?? 0) + 1);
      const type = baseType(c.type);
      const length = c.length.replace(/\s+/g, '');
      const vkey = `${c.name.toLowerCase()}|${type}|${length}`;
      const v = g.variants.get(vkey) ?? { physical: c.name, type: c.type.trim().toUpperCase(), length, columns: [] };
      g.variants.set(vkey, v);
      v.columns.push(`${t.name}.${c.name}`);
    }
  }
  const top = <T>(m: Map<T, number>): T | undefined => [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const terms: DictTerm[] = [];
  const conflicts: DictConflict[] = [];
  for (const g of groups.values()) {
    const variants = [...g.variants.values()].sort((a, b) => b.columns.length - a.columns.length);
    const best = variants[0];
    const logical = top(g.logicals)!;
    const description = top(g.comments);
    terms.push({ logical, physical: best.physical, ...(best.type ? { type: best.type } : {}), ...(best.length ? { length: best.length } : {}), ...(description ? { description } : {}) });
    if (variants.length > 1) conflicts.push({ logical, variants });
  }
  terms.sort((a, b) => a.logical.localeCompare(b.logical));
  conflicts.sort((a, b) => b.variants.length - a.variants.length || a.logical.localeCompare(b.logical));
  return { terms, conflicts, skipped };
}
