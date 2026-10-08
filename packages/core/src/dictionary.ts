// 표준 용어 사전: 논리명(한글) → 표준 물리명·타입·길이. 예) 회원번호 → MBR_NO VARCHAR(20).
// 사전에 있는 용어만 쓴다 (단어를 이어 붙여 이름을 만들지 않는다).
// 물리명 표기(snake_case / SNAKE_CASE / camelCase)는 사전 용어들로 판단하고, 한 사전 안에서 섞이지 않게 막는다.
// 논리명이 아직 없는 용어도 둘 수 있다 (ERD에서 만든 초안 등 — 나중에 채운다). 그런 용어는 물리명으로 구분한다.
// ERD 구조(스키마)와 따로 문서의 'dictionary' 맵에 둔다 — SQL·비교·DB 동기화·버전에는 영향이 없다.
// 사전이 없으면 아무 검사도 하지 않는다.

import * as Y from 'yjs';
import type { Column } from './model';

export interface DictTerm {
  /** 논리명 (예: 회원번호). 비어 있으면 아직 안 정한 것 */
  logical: string;
  /** 물리명 (예: MBR_NO) */
  physical: string;
  /** 타입 (예: VARCHAR). 비우면 타입은 검사하지 않는다 */
  type?: string;
  length?: string;
  description?: string;
}

export interface Dictionary {
  terms: DictTerm[];
  updatedAt?: string;
}

/** 같은 용어인지 볼 때 쓰는 키 (띄어쓰기·대소문자 무시) */
export const dictKey = (s: string) => s.replace(/\s+/g, '').toLowerCase();
/** 같은 물리명인지 볼 때 쓰는 키 (대소문자 무시) */
const physicalKey = (name: string) => name.trim().toLowerCase();
/** 사전 안에서 용어를 구분하는 키: 논리명, 논리명이 없으면 물리명 */
export const termKey = (t: Pick<DictTerm, 'logical' | 'physical'>) => (t.logical.trim() ? dictKey(t.logical) : `@${physicalKey(t.physical)}`);

// ── 물리명 표기 ──────────────────────────────────────────

/** snake: member_no / SNAKE: MEMBER_NO / camel: memberNo */
export type NameStyle = 'snake' | 'SNAKE' | 'camel';

export const NAME_STYLE_LABEL: Record<NameStyle, string> = { snake: 'snake_case', SNAKE: 'SNAKE_CASE', camel: 'camelCase' };
const STYLE_WORDS: Record<NameStyle, (words: string[]) => string> = {
  snake: (w) => w.join('_').toLowerCase(),
  SNAKE: (w) => w.join('_').toUpperCase(),
  camel: (w) => w.map((x, i) => (i ? x[0].toUpperCase() + x.slice(1).toLowerCase() : x.toLowerCase())).join(''),
};
const STYLE_RE: Record<NameStyle, RegExp> = {
  snake: /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/,
  SNAKE: /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/,
  camel: /^[a-z][a-z0-9]*([A-Z][a-z0-9]*)*$/,
};

/** 이 이름이 그 표기에 맞는지. 한 단어(price, PRICE)는 대소문자만 맞으면 된다 */
export function fitsStyle(name: string, style: NameStyle): boolean {
  return STYLE_RE[style].test(name.trim());
}

/** 낱말로 나눠 그 표기로 (memberNo → member_no) */
export function toStyle(name: string, style: NameStyle): string {
  const words = name.trim().split(/[_\s-]+/).flatMap((w) => w.split(/(?<=[a-z0-9])(?=[A-Z])/)).filter(Boolean);
  return words.length ? STYLE_WORDS[style](words) : name;
}

export interface StyleCheck {
  /** 사전의 표기 (용어가 없으면 null) */
  style: NameStyle | null;
  /** 그 표기와 다른 물리명의 용어 (있으면 섞인 것) */
  offenders: DictTerm[];
}

/**
 * 물리명들로 표기를 판단한다: 가장 많은 용어가 맞는 표기 (같으면 snake → SNAKE → camel).
 * 한 단어 이름(price)은 어느 쪽에도 맞는다. 그 표기에 안 맞는 용어가 offenders.
 */
export function detectStyle(terms: Pick<DictTerm, 'logical' | 'physical'>[]): StyleCheck {
  if (!terms.length) return { style: null, offenders: [] };
  const styles: NameStyle[] = ['snake', 'SNAKE', 'camel'];
  const fits = styles.map((s) => terms.filter((t) => fitsStyle(t.physical, s)).length);
  const style = styles[fits.indexOf(Math.max(...fits))];
  return { style, offenders: terms.filter((t) => !fitsStyle(t.physical, style)) as DictTerm[] };
}

const termLabel = (t: Pick<DictTerm, 'logical' | 'physical'>) => (t.logical.trim() ? `${t.logical}=${t.physical}` : t.physical);

/** 섞였을 때 사람에게 보일 안내 */
export function mixedStyleMessage(check: StyleCheck): string {
  const list = check.offenders.slice(0, 10).map(termLabel).join(', ');
  return `물리명 표기가 섞여 있습니다. 대부분 ${NAME_STYLE_LABEL[check.style!]}인데 다른 표기가 ${check.offenders.length}개 있습니다 (${list}${check.offenders.length > 10 ? ' …' : ''}). snake_case·camelCase 등 한 가지로 맞춰 주세요.`;
}

/** 같은 물리명을 쓰는 용어 묶음 (서로 다른 용어가 같은 물리명이면 사전에서 헷갈린다) */
export function duplicatePhysicals(terms: DictTerm[]): DictTerm[][] {
  const by = new Map<string, DictTerm[]>();
  for (const t of terms) by.set(physicalKey(t.physical), [...(by.get(physicalKey(t.physical)) ?? []), t]);
  return [...by.values()].filter((g) => g.length > 1);
}

// ── 문서에 저장 ──────────────────────────────────────────

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

const allTerms = (doc: Y.Doc) => [...(termsMap(doc).values() as IterableIterator<DictTerm>)];

/** 사전 (용어가 하나도 없으면 null). 논리명 순, 논리명이 없는 용어는 뒤에 */
export function readDictionary(doc: Y.Doc): Dictionary | null {
  const root = dictMap(doc);
  const terms = [...(((root.get('terms') as Y.Map<DictTerm> | undefined)?.values()) ?? [])].map((t) => ({ ...t, logical: t.logical ?? '' }));
  if (!terms.length) return null;
  terms.sort((a, b) => Number(!a.logical) - Number(!b.logical) || a.logical.localeCompare(b.logical) || a.physical.localeCompare(b.physical));
  return { terms, updatedAt: (root.get('updatedAt') as string | undefined) ?? undefined };
}

const cleanTerm = (t: DictTerm): DictTerm | null => {
  const physical = t.physical?.trim();
  if (!physical) return null;
  const out: DictTerm = { logical: t.logical?.trim() ?? '', physical };
  if (t.type?.trim()) out.type = t.type.trim().toUpperCase();
  if (t.length?.toString().trim()) out.length = t.length.toString().trim();
  if (t.description?.trim()) out.description = t.description.trim();
  return out;
};

/** 넣은 뒤의 용어 목록 (replace: 새 것만, merge: 같은 용어는 새 것으로) */
export function mergedTerms(current: DictTerm[], incoming: DictTerm[], mode: 'replace' | 'merge'): DictTerm[] {
  const map = new Map(mode === 'merge' ? current.map((t) => [termKey(t), t] as const) : []);
  for (const raw of incoming) {
    const t = cleanTerm(raw);
    if (t) map.set(termKey(t), t);
  }
  return [...map.values()];
}

/**
 * 여러 용어를 넣는다 (엑셀·ERD 초안·다른 프로젝트). replace면 기존 용어를 지우고, merge면 같은 용어만 덮어쓴다. 넣은 수.
 * 넣은 뒤 물리명 표기가 섞이면 넣지 않고 오류를 낸다.
 */
export function writeDictionary(doc: Y.Doc, input: { terms: DictTerm[] }, mode: 'replace' | 'merge' = 'replace'): number {
  const check = detectStyle(mergedTerms(allTerms(doc), input.terms, mode));
  if (check.offenders.length) throw new Error(mixedStyleMessage(check));
  const terms = termsMap(doc);
  if (mode === 'replace') terms.clear();
  let n = 0;
  for (const raw of input.terms) {
    const term = cleanTerm(raw);
    if (!term) continue;
    // 논리명을 채운 용어가 들어오면, 같은 물리명의 논리명 없던 용어는 그것으로 바뀐다
    if (term.logical) terms.delete(termKey({ logical: '', physical: term.physical }));
    terms.set(termKey(term), term);
    n++;
  }
  dictMap(doc).set('updatedAt', new Date().toISOString());
  return n;
}

/**
 * 용어 하나 넣기·고치기. 고치는 것이면 previous에 원래 용어.
 * 사전 표기와 다른 물리명, 다른 용어가 이미 쓰는 물리명·논리명은 넣지 않는다.
 */
export function setDictEntry(doc: Y.Doc, entry: DictTerm, previous?: Pick<DictTerm, 'logical' | 'physical'>): void {
  const clean = cleanTerm(entry);
  if (!clean) throw new Error('물리명을 입력하세요');
  const map = termsMap(doc);
  const prevKey = previous ? termKey(previous) : null;
  const others = allTerms(doc).filter((t) => termKey(t) !== prevKey && termKey(t) !== termKey(clean));
  const { style } = detectStyle(others);
  if (style && !fitsStyle(clean.physical, style)) {
    throw new Error(`이 사전은 ${NAME_STYLE_LABEL[style]}입니다. "${clean.physical}" 대신 "${toStyle(clean.physical, style)}"처럼 입력하세요.`);
  }
  // 논리명 없던 같은 물리명 용어에 논리명을 채우는 것은 같은 용어로 본다
  const same = others.find((t) => physicalKey(t.physical) === physicalKey(clean.physical) && !(clean.logical && !t.logical));
  if (same) throw new Error(`물리명 ${clean.physical}은(는) 이미 ${same.logical ? `"${same.logical}"(으)로` : '(논리명 없이)'} 사전에 있습니다.`);
  const sameLogical = clean.logical && others.find((t) => t.logical && dictKey(t.logical) === dictKey(clean.logical));
  if (sameLogical) throw new Error(`논리명 "${clean.logical}"은(는) 이미 ${sameLogical.physical}(으)로 사전에 있습니다.`);
  if (prevKey && prevKey !== termKey(clean)) map.delete(prevKey);
  if (clean.logical) map.delete(termKey({ logical: '', physical: clean.physical }));
  map.set(termKey(clean), clean);
  dictMap(doc).set('updatedAt', new Date().toISOString());
}

export function removeDictEntry(doc: Y.Doc, term: Pick<DictTerm, 'logical' | 'physical'>): void {
  termsMap(doc).delete(termKey(term));
}

export function clearDictionary(doc: Y.Doc): void {
  termsMap(doc).clear();
  // 예전 버전이 남긴 표준 단어·표기 설정도 지운다 (지금은 쓰지 않음)
  dictMap(doc).delete('words');
  dictMap(doc).delete('case');
  dictMap(doc).delete('updatedAt');
}

// ── 찾기 ──────────────────────────────────────────

export interface DictMatch {
  physical: string;
  type?: string;
  length?: string;
  description?: string;
}

/** 큰 사전에서 여러 번 찾을 때 쓰는 색인 (사전이 바뀔 때만 다시 만든다) */
export interface DictIndex {
  dict: Dictionary;
  /** 논리명 → 용어 (논리명이 있는 것만) */
  terms: Map<string, DictTerm>;
  /** 물리명(대소문자 무시) → 용어 */
  byPhysical: Map<string, DictTerm>;
  /** 사전의 물리명 표기 */
  style: NameStyle | null;
}

const indexCache = new WeakMap<Dictionary, DictIndex>();

export function dictIndex(dict: Dictionary): DictIndex {
  const cached = indexCache.get(dict);
  if (cached) return cached;
  const terms = new Map(dict.terms.filter((t) => t.logical).map((t) => [dictKey(t.logical), t]));
  const byPhysical = new Map<string, DictTerm>();
  // 같은 물리명이면 논리명이 있는 용어가 먼저
  for (const t of [...dict.terms].sort((a, b) => Number(!a.logical) - Number(!b.logical))) if (!byPhysical.has(physicalKey(t.physical))) byPhysical.set(physicalKey(t.physical), t);
  const index = { dict, terms, byPhysical, style: detectStyle(dict.terms).style };
  indexCache.set(dict, index);
  return index;
}

const asIndex = (dict: Dictionary | DictIndex) => ('byPhysical' in dict ? dict : dictIndex(dict));

/** 사전의 물리명 표기 (용어가 없으면 null) */
export function dictionaryStyle(dict: Dictionary | DictIndex | null | undefined): NameStyle | null {
  return dict ? asIndex(dict).style : null;
}

/** 논리명으로 표준 용어 찾기 (없으면 null) */
export function lookupTerm(dict: Dictionary | DictIndex | null | undefined, logical: string): DictMatch | null {
  if (!dict || !logical.trim()) return null;
  const term = asIndex(dict).terms.get(dictKey(logical));
  if (!term) return null;
  return {
    physical: term.physical,
    ...(term.type ? { type: term.type } : {}),
    ...(term.length ? { length: term.length } : {}),
    ...(term.description ? { description: term.description } : {}),
  };
}

/** 물리명으로 용어 찾기 (논리명이 빈 용어일 수도 있다) */
export function lookupPhysical(dict: Dictionary | DictIndex | null | undefined, physical: string): DictTerm | null {
  if (!dict || !physical.trim()) return null;
  return asIndex(dict).byPhysical.get(physicalKey(physical)) ?? null;
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

/**
 * 입력하는 동안 보여 줄 후보: 물리명 칸이면 물리명으로, 논리명 칸이면 논리명으로 찾는다.
 * 앞부분이 맞는 것을 먼저 (mem → member_id, memory_id …), 그다음 중간에 들어 있는 것.
 */
export function suggestTerms(dict: Dictionary | null | undefined, query: string, by: 'physical' | 'logical', limit = 8): DictTerm[] {
  const q = by === 'physical' ? query.trim().toLowerCase() : dictKey(query);
  if (!dict || !q) return [];
  const key = (t: DictTerm) => (by === 'physical' ? t.physical.toLowerCase() : dictKey(t.logical));
  const starts: DictTerm[] = [];
  const contains: DictTerm[] = [];
  for (const t of dict.terms) {
    if (by === 'logical' && !t.logical) continue;
    const k = key(t);
    if (k === q) continue; // 이미 그대로 입력함
    if (k.startsWith(q)) starts.push(t);
    else if (k.includes(q)) contains.push(t);
  }
  return [...starts.sort((a, b) => key(a).length - key(b).length), ...contains].slice(0, limit);
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

/**
 * 컬럼이 사전을 따르는지. 논리명이 없으면 null (논리명 없음은 설계 검사가 따로 알린다).
 * 논리명은 사전에 없지만 같은 물리명이 논리명 없이 사전에 있으면 사전에 있는 것으로 본다 (사전 쪽 논리명을 채우면 된다).
 */
export function checkColumnAgainstDictionary(dict: Dictionary | DictIndex | null | undefined, column: Pick<Column, 'name' | 'logicalName' | 'type' | 'length'>): ColumnDictCheck | null {
  if (!dict || !column.logicalName.trim()) return null;
  const match = lookupTerm(dict, column.logicalName);
  if (!match) {
    const owner = lookupPhysical(dict, column.name);
    return owner && !owner.logical ? { status: 'ok', diffs: [] } : { status: 'unknown', diffs: [] };
  }
  const diffs: string[] = [];
  const patch: Partial<Column> = {};
  if (match.physical !== column.name.trim()) {
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

/** 사전에 없는 컬럼의 이름이 사전 표기와 다르면 바꿀 이름 (맞으면 null) */
export function styleSuggestion(dict: Dictionary | DictIndex | null | undefined, name: string): { style: NameStyle; suggestion: string } | null {
  const style = dictionaryStyle(dict);
  if (!style || !name.trim() || fitsStyle(name, style)) return null;
  return { style, suggestion: toStyle(name, style) };
}

/** 컬럼 → 사전 용어 */
export const termFromColumn = (c: Pick<Column, 'name' | 'logicalName' | 'type' | 'length' | 'comment'>): DictTerm => ({
  logical: c.logicalName.trim(),
  physical: c.name.trim(),
  ...(c.type ? { type: c.type } : {}),
  ...(c.length ? { length: c.length } : {}),
  ...(c.comment?.trim() ? { description: c.comment.trim() } : {}),
});

/**
 * 컬럼들 중 사전에 넣을 수 있는 새 용어 (사전에 없는 논리명, 사전 표기에 맞고, 같은 물리명이 사전에 없는 것).
 * 같은 물리명이 논리명 없이 사전에 있으면 그 용어의 논리명을 채운다 (fill).
 * skipped: 넣지 못한 이유 (다른 표기, 다른 논리명으로 이미 있는 물리명)
 */
export function newTermsFromColumns(
  dict: Dictionary | DictIndex,
  columns: { table: string; column: Pick<Column, 'name' | 'logicalName' | 'type' | 'length' | 'comment'> }[],
): { add: DictTerm[]; skipped: { where: string; reason: string }[] } {
  const index = asIndex(dict);
  const add: DictTerm[] = [];
  const skipped: { where: string; reason: string }[] = [];
  for (const { table, column: c } of columns) {
    if (!c.logicalName.trim()) continue;
    const r = checkColumnAgainstDictionary(index, c);
    const owner = lookupPhysical(index, c.name);
    const fill = owner && !owner.logical;
    if (r?.status !== 'unknown' && !fill) continue;
    const where = `${table}.${c.name}`;
    const style = styleSuggestion(index, c.name);
    if (style) {
      skipped.push({ where, reason: `사전 표기(${NAME_STYLE_LABEL[style.style]})와 다릅니다 — ${style.suggestion}(으)로 바꾸세요` });
      continue;
    }
    if (owner && !fill) {
      skipped.push({ where, reason: `물리명 ${c.name}은(는) 사전에 "${owner.logical}"(으)로 있습니다 — 논리명을 "${owner.logical}"(으)로 쓰거나 다른 물리명을 쓰세요` });
      continue;
    }
    if (add.some((x) => dictKey(x.logical) === dictKey(c.logicalName) || physicalKey(x.physical) === physicalKey(c.name))) continue;
    add.push(termFromColumn(c));
  }
  return { add, skipped };
}

/**
 * AI가 바꾼 뒤 사전과 맞추기: 이번에 새로 만들거나 고친 컬럼 중
 * - 사전과 다른 것·다른 표기 → 고치라는 안내
 * - 사전에 없는 용어 → 사전에 넣을 용어 (같은 논리명·물리명이 이미 있거나 이번에 이미 넣은 것은 빼고)
 * 사전이 없으면 아무것도 하지 않는다.
 */
export function syncDictionaryForAi(
  dict: Dictionary | null | undefined,
  before: { tables: { id: string; columns: Column[] }[] },
  after: { tables: { id: string; name: string; columns: Column[] }[] },
  limit = 30,
): { add: DictTerm[]; notes: string[] } {
  if (!dict?.terms.length) return { add: [], notes: [] };
  const index = dictIndex(dict);
  const label = index.style ? NAME_STYLE_LABEL[index.style] : '';
  const prev = new Map(before.tables.flatMap((t) => t.columns.map((c) => [c.id, c] as const)));
  const changed: { table: string; column: Column }[] = [];
  const notes: string[] = [];
  for (const t of after.tables) {
    for (const c of t.columns) {
      const old = prev.get(c.id);
      if (old && old.name === c.name && old.logicalName === c.logicalName && old.type === c.type && old.length === c.length) continue;
      const r = checkColumnAgainstDictionary(index, c);
      if (r?.status === 'mismatch') {
        notes.push(`${t.name}.${c.name}: "${c.logicalName}"의 표준은 ${describeMatch(r.match!)} — updateColumn으로 맞추세요`);
        continue;
      }
      // 논리명이 없는 컬럼은 사전에 넣지 않지만 표기는 본다
      const style = !c.logicalName.trim() ? styleSuggestion(index, c.name) : null;
      if (style) notes.push(`${t.name}.${c.name}: 사전 표기(${label})와 다릅니다 — ${style.suggestion}(으)로 바꾸세요`);
      changed.push({ table: t.name, column: c });
    }
  }
  const { add, skipped } = newTermsFromColumns(index, changed);
  notes.push(...skipped.map((s) => `${s.where}: ${s.reason}${s.reason.startsWith('사전 표기') ? ' (그래서 사전에 넣지 않았습니다)' : ''}`));
  return { add, notes: notes.length > limit ? [...notes.slice(0, limit), `… 외 ${notes.length - limit}개`] : notes };
}

/**
 * 사전에 용어 여러 개를 더한다 (같은 논리명·물리명이 이미 있으면 건너뜀). 더한 용어.
 * 같은 물리명이 논리명 없이 있으면 그 용어에 논리명을 채운다.
 */
export function addMissingTerms(doc: Y.Doc, terms: DictTerm[]): DictTerm[] {
  const map = termsMap(doc);
  const existing = allTerms(doc);
  const logicals = new Set(existing.filter((t) => t.logical).map((t) => dictKey(t.logical)));
  const physicals = new Map(existing.map((t) => [physicalKey(t.physical), t] as const));
  const added: DictTerm[] = [];
  for (const raw of terms) {
    const t = cleanTerm(raw);
    if (!t || (t.logical && logicals.has(dictKey(t.logical)))) continue;
    const owner = physicals.get(physicalKey(t.physical));
    if (owner && (owner.logical || !t.logical)) continue;
    if (owner) map.delete(termKey(owner));
    map.set(termKey(t), t);
    if (t.logical) logicals.add(dictKey(t.logical));
    physicals.set(physicalKey(t.physical), t);
    added.push(t);
  }
  if (added.length) dictMap(doc).set('updatedAt', new Date().toISOString());
  return added;
}

/** 논리명이 없는 사전 용어에, 같은 물리명을 쓰는 ERD 컬럼의 논리명을 채울 수 있는 것 */
export function logicalFillsFromSchema(dict: Dictionary, schema: { tables: { columns: Column[] }[] }): DictTerm[] {
  const empty = new Map(dict.terms.filter((t) => !t.logical).map((t) => [physicalKey(t.physical), t] as const));
  if (!empty.size) return [];
  const taken = new Set(dict.terms.filter((t) => t.logical).map((t) => dictKey(t.logical)));
  const out = new Map<string, DictTerm>();
  for (const t of schema.tables) {
    for (const c of t.columns) {
      const term = empty.get(physicalKey(c.name));
      if (!term || !c.logicalName.trim() || out.has(physicalKey(c.name)) || taken.has(dictKey(c.logicalName))) continue;
      out.set(physicalKey(c.name), { ...term, logical: c.logicalName.trim() });
      taken.add(dictKey(c.logicalName));
    }
  }
  return [...out.values()];
}

// ── ERD에서 사전 만들기 ──────────────────────────────

export interface DictVariant {
  physical: string;
  type: string;
  length: string;
  /** 이 이름·타입을 쓰는 곳 (테이블.컬럼) */
  columns: string[];
}

/** ERD에서 만든 초안의 한 줄: 기본으로 고른 이름·타입 + 다르게 쓴 것들 */
export interface DictDraftRow extends DictTerm {
  /** 많이 쓰는 순 (첫 번째가 기본). 2개 이상이면 다르게 쓴 곳이 있는 것 */
  variants: DictVariant[];
}

/**
 * 지금 ERD의 컬럼으로 사전 초안을 만든다: 논리명이 같은 컬럼을 묶어 가장 많이 쓰는 물리명·타입·길이를 용어로.
 * 논리명이 없는 컬럼은 물리명으로 묶어 논리명 없는 용어로 넣는다 (나중에 채운다).
 */
export function dictionaryFromSchema(schema: { tables: { name: string; columns: Column[] }[] }): DictDraftRow[] {
  const groups = new Map<string, { logicals: Map<string, number>; comments: Map<string, number>; variants: Map<string, DictVariant> }>();
  for (const t of schema.tables) {
    for (const c of t.columns) {
      const logical = c.logicalName.trim();
      const key = logical ? dictKey(logical) : `@${physicalKey(c.name)}`;
      const g = groups.get(key) ?? { logicals: new Map(), comments: new Map(), variants: new Map() };
      groups.set(key, g);
      if (logical) g.logicals.set(logical, (g.logicals.get(logical) ?? 0) + 1);
      if (c.comment.trim()) g.comments.set(c.comment.trim(), (g.comments.get(c.comment.trim()) ?? 0) + 1);
      const length = c.length.replace(/\s+/g, '');
      const vkey = `${c.name.toLowerCase()}|${baseType(c.type)}|${length}`;
      const v = g.variants.get(vkey) ?? { physical: c.name, type: c.type.trim().toUpperCase(), length, columns: [] };
      g.variants.set(vkey, v);
      v.columns.push(`${t.name}.${c.name}`);
    }
  }
  const top = <T>(m: Map<T, number>): T | undefined => [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const rows: DictDraftRow[] = [];
  for (const g of groups.values()) {
    const variants = [...g.variants.values()].sort((a, b) => b.columns.length - a.columns.length);
    const best = variants[0];
    const description = top(g.comments);
    rows.push({ logical: top(g.logicals) ?? '', physical: best.physical, ...(best.type ? { type: best.type } : {}), ...(best.length ? { length: best.length } : {}), ...(description ? { description } : {}), variants });
  }
  return rows.sort((a, b) => Number(!a.logical) - Number(!b.logical) || a.logical.localeCompare(b.logical) || a.physical.localeCompare(b.physical));
}
