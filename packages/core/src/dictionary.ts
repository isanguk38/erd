// 표준 용어 사전: 논리명(한글) → 표준 물리명·타입·길이.
// 예) 회원번호 → MBR_NO VARCHAR(20). 사전에 없는 용어는 표준 단어(회원=MBR, 번호=NO)를 이어 붙여 물리명을 만든다.
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

export interface DictWord {
  /** 단어 (예: 회원) */
  logical: string;
  /** 약어 (예: MBR) */
  physical: string;
  description?: string;
}

/** 물리명을 채울 때 대소문자: 사전 그대로 / 소문자 / 대문자 */
export type DictCase = 'asis' | 'lower' | 'upper';

export interface Dictionary {
  terms: DictTerm[];
  words: DictWord[];
  case: DictCase;
  updatedAt?: string;
}

export function emptyDictionary(): Dictionary {
  return { terms: [], words: [], case: 'asis' };
}

/** 같은 용어인지 볼 때 쓰는 키 (띄어쓰기·대소문자 무시) */
export const dictKey = (s: string) => s.replace(/\s+/g, '').toLowerCase();

function dictMap(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap('dictionary');
}

function sub(doc: Y.Doc, key: 'terms' | 'words'): Y.Map<unknown> {
  const root = dictMap(doc);
  let m = root.get(key) as Y.Map<unknown> | undefined;
  if (!m) {
    m = new Y.Map();
    root.set(key, m);
  }
  return m;
}

/** 사전 (용어·단어가 하나도 없으면 null) */
export function readDictionary(doc: Y.Doc): Dictionary | null {
  const root = dictMap(doc);
  const terms = [...(((root.get('terms') as Y.Map<DictTerm> | undefined)?.values()) ?? [])].map((t) => ({ ...t }));
  const words = [...(((root.get('words') as Y.Map<DictWord> | undefined)?.values()) ?? [])].map((w) => ({ ...w }));
  if (!terms.length && !words.length) return null;
  terms.sort((a, b) => a.logical.localeCompare(b.logical));
  words.sort((a, b) => a.logical.localeCompare(b.logical));
  return { terms, words, case: ((root.get('case') as DictCase) ?? 'asis'), updatedAt: (root.get('updatedAt') as string | undefined) ?? undefined };
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
const cleanWord = (w: DictWord): DictWord | null => {
  const logical = w.logical?.trim();
  const physical = w.physical?.trim();
  if (!logical || !physical) return null;
  return w.description?.trim() ? { logical, physical, description: w.description.trim() } : { logical, physical };
};

/** 엑셀에서 읽은 사전을 넣는다. replace면 기존 것을 지우고, merge면 같은 논리명만 덮어쓴다 */
export function writeDictionary(doc: Y.Doc, input: { terms?: DictTerm[]; words?: DictWord[]; case?: DictCase }, mode: 'replace' | 'merge' = 'replace'): { terms: number; words: number } {
  const terms = sub(doc, 'terms');
  const words = sub(doc, 'words');
  if (mode === 'replace') {
    if (input.terms) terms.clear();
    if (input.words) words.clear();
  }
  let t = 0;
  let w = 0;
  for (const raw of input.terms ?? []) {
    const term = cleanTerm(raw);
    if (!term) continue;
    terms.set(dictKey(term.logical), term);
    t++;
  }
  for (const raw of input.words ?? []) {
    const word = cleanWord(raw);
    if (!word) continue;
    words.set(dictKey(word.logical), word);
    w++;
  }
  if (input.case) dictMap(doc).set('case', input.case);
  dictMap(doc).set('updatedAt', new Date().toISOString());
  return { terms: t, words: w };
}

/** 용어·단어 하나 넣기(같은 논리명이면 바꾸기). 논리명을 바꿨으면 previous에 옛 논리명 */
export function setDictEntry(doc: Y.Doc, kind: 'terms' | 'words', entry: DictTerm | DictWord, previous?: string): void {
  const clean = kind === 'terms' ? cleanTerm(entry as DictTerm) : cleanWord(entry as DictWord);
  if (!clean) throw new Error('논리명과 물리명을 모두 입력하세요');
  const map = sub(doc, kind);
  if (previous && dictKey(previous) !== dictKey(clean.logical)) map.delete(dictKey(previous));
  map.set(dictKey(clean.logical), clean);
  dictMap(doc).set('updatedAt', new Date().toISOString());
}

export function removeDictEntry(doc: Y.Doc, kind: 'terms' | 'words', logical: string): void {
  sub(doc, kind).delete(dictKey(logical));
}

export function setDictCase(doc: Y.Doc, value: DictCase): void {
  dictMap(doc).set('case', value);
}

export function clearDictionary(doc: Y.Doc): void {
  sub(doc, 'terms').clear();
  sub(doc, 'words').clear();
  dictMap(doc).delete('updatedAt');
}

// ── 찾기 ──────────────────────────────────────────

export interface DictMatch {
  /** 사전 대소문자 설정을 적용한 물리명 */
  physical: string;
  type?: string;
  length?: string;
  description?: string;
  /** term: 용어 그대로 / words: 단어를 이어 붙여 만듦 */
  source: 'term' | 'words';
  /** 단어로 만들었으면 쓴 단어들 (예: ['회원', '번호']) */
  parts?: string[];
}

export function applyDictCase(name: string, c: DictCase): string {
  return c === 'lower' ? name.toLowerCase() : c === 'upper' ? name.toUpperCase() : name;
}

/** 큰 사전에서 여러 번 찾을 때 쓰는 색인 (사전이 바뀔 때만 다시 만든다) */
export interface DictIndex {
  dict: Dictionary;
  terms: Map<string, DictTerm>;
  words: Map<string, DictWord>;
  /** 물리명(소문자) → 용어 */
  byPhysical: Map<string, DictTerm>;
  maxWord: number;
}

const indexCache = new WeakMap<Dictionary, DictIndex>();

export function dictIndex(dict: Dictionary): DictIndex {
  const cached = indexCache.get(dict);
  if (cached) return cached;
  const terms = new Map(dict.terms.map((t) => [dictKey(t.logical), t]));
  const words = new Map(dict.words.map((w) => [dictKey(w.logical), w]));
  const byPhysical = new Map<string, DictTerm>();
  for (const t of dict.terms) if (!byPhysical.has(t.physical.toLowerCase())) byPhysical.set(t.physical.toLowerCase(), t);
  const index = { dict, terms, words, byPhysical, maxWord: Math.max(0, ...[...words.keys()].map((k) => k.length)) };
  indexCache.set(dict, index);
  return index;
}

/** 단어로 나누기: 가장 적은 단어 수로 논리명 전체를 덮는 조합 (못 덮으면 null) */
function segment(index: DictIndex, key: string): DictWord[] | null {
  if (!key || !index.words.size) return null;
  const best: (DictWord[] | null)[] = Array(key.length + 1).fill(null);
  best[0] = [];
  for (let i = 0; i < key.length; i++) {
    const head = best[i];
    if (!head) continue;
    for (let len = Math.min(index.maxWord, key.length - i); len >= 1; len--) {
      const word = index.words.get(key.slice(i, i + len));
      if (!word) continue;
      const next = [...head, word];
      const cur = best[i + len];
      if (!cur || next.length < cur.length) best[i + len] = next;
    }
  }
  return best[key.length];
}

/** 논리명으로 표준 찾기: 용어가 있으면 용어, 없으면 단어를 이어 붙인 물리명. 둘 다 안 되면 null */
export function lookupTerm(dict: Dictionary | DictIndex | null | undefined, logical: string): DictMatch | null {
  if (!dict || !logical.trim()) return null;
  const index = 'byPhysical' in dict ? dict : dictIndex(dict);
  const key = dictKey(logical);
  const term = index.terms.get(key);
  if (term) {
    return {
      physical: applyDictCase(term.physical, index.dict.case),
      ...(term.type ? { type: term.type } : {}),
      ...(term.length ? { length: term.length } : {}),
      ...(term.description ? { description: term.description } : {}),
      source: 'term',
    };
  }
  const parts = segment(index, key);
  if (!parts?.length) return null;
  return { physical: applyDictCase(parts.map((w) => w.physical).join('_'), index.dict.case), source: 'words', parts: parts.map((w) => w.logical) };
}

/** 물리명으로 용어 찾기 (논리명이 빈 컬럼을 채울 때) */
export function lookupPhysical(dict: Dictionary | DictIndex | null | undefined, physical: string): DictTerm | null {
  if (!dict || !physical.trim()) return null;
  const index = 'byPhysical' in dict ? dict : dictIndex(dict);
  return index.byPhysical.get(physical.trim().toLowerCase()) ?? null;
}

/** 사전 안에서 찾기 (논리명·물리명·설명에 글자가 들어 있는 것) */
export function searchDictionary<T extends DictTerm | DictWord>(entries: T[], query: string, limit = 200): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries.slice(0, limit);
  const qk = dictKey(q);
  const out: T[] = [];
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
  if (match.source === 'term' && match.type) {
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
  if (match.source === 'term' && match.type) {
    const t = splitDictType(match.type, match.length);
    if (t.type) patch.type = t.type;
    patch.length = t.length ?? '';
  }
  return patch;
}

/** 표준을 사람이 읽는 글로 (예: "MBR_NO VARCHAR(20)") */
export function describeMatch(match: DictMatch): string {
  const t = match.source === 'term' && match.type ? splitDictType(match.type, match.length) : null;
  return `${match.physical}${t?.type ? ` ${t.type}${t.length ? `(${t.length})` : ''}` : ''}${match.source === 'words' ? ` (단어 ${match.parts?.join('+')})` : ''}`;
}

/**
 * 이번에 새로 만들거나 고친 컬럼 중 사전과 다른 것 (AI 편집 결과에 붙인다).
 * 사전이 없으면 빈 배열.
 */
export function dictionaryNotes(dict: Dictionary | null | undefined, before: { tables: { id: string; columns: Column[] }[] }, after: { tables: { id: string; name: string; columns: Column[] }[] }, limit = 30): string[] {
  if (!dict || (!dict.terms.length && !dict.words.length)) return [];
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
