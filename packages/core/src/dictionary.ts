// 표준 용어 사전: 논리명(한글) → 표준 물리명·타입·길이. 예) 회원번호 → MBR_NO VARCHAR(20).
// 사전에 있는 용어만 쓴다 (단어를 이어 붙여 이름을 만들지 않는다).
// 물리명 표기(snake_case / SNAKE_CASE / camelCase)는 프로젝트의 이름 표기 기준(naming.ts)을 따른다. 테이블 용어와 컬럼 용어는 따로 본다.
// 기준을 정했으면 그 표기만 넣을 수 있고, 정하지 않았으면 사전 용어들로 판단한다 (같은 종류 안에서 섞이지 않게 막는다).
// 논리명이 아직 없는 용어도 둘 수 있다 (ERD에서 만든 초안 등 — 나중에 채운다). 그런 용어는 물리명으로 구분한다.
// ERD 구조(스키마)와 따로 문서의 'dictionary' 맵에 둔다 — SQL·비교·DB 동기화·버전에는 영향이 없다.
// 사전이 없으면 아무 검사도 하지 않는다.

import * as Y from 'yjs';
import type { Column } from './model';
import { readMeta } from './ydoc';
import { fitsStyle, isToolTable, NAME_KIND_LABEL, NAME_STYLE_LABEL, toStyle, type NameKind, type NameStyle, type NamingSetting, type NamingStyles } from './naming';

export interface DictTerm {
  /** 테이블 용어면 'table' (없으면 컬럼 용어). 테이블 용어는 타입·길이가 없다 */
  kind?: 'table';
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
  /** 프로젝트에 저장한 이름 표기 기준 (테이블·컬럼 따로. 정한 쪽은 사전 표기도 이것, 아니면 용어들로 판단) */
  namingStyle?: NamingSetting;
}

/** 같은 용어인지 볼 때 쓰는 키 (띄어쓰기·대소문자 무시) */
export const dictKey = (s: string) => s.replace(/\s+/g, '').toLowerCase();
/** 같은 물리명인지 볼 때 쓰는 키 (대소문자 무시) */
const physicalKey = (name: string) => name.trim().toLowerCase();
/** 사전 안에서 용어를 구분하는 키: 논리명, 논리명이 없으면 물리명 (테이블 용어는 앞에 t:) */
export const termKey = (t: Pick<DictTerm, 'logical' | 'physical' | 'kind'>) => `${t.kind === 'table' ? 't:' : ''}${t.logical.trim() ? dictKey(t.logical) : `@${physicalKey(t.physical)}`}`;
const isTable = (t: Pick<DictTerm, 'kind'>) => t.kind === 'table';
/** 같은 구분(테이블/컬럼) 안의 물리명 키 */
const scopedPhysical = (t: Pick<DictTerm, 'physical' | 'kind'>) => `${t.kind === 'table' ? 't:' : ''}${physicalKey(t.physical)}`;
export const TERM_KIND_LABEL = { table: '테이블', column: '컬럼' } as const;
/**
 * 같은 물리명을 함께 써도 되는지: 컬럼 용어는 각자 논리명이 있으면 된다 (예: 결제상태·구독상태 → status, 테이블 이름이 뜻을 보충).
 * 논리명이 없는 용어와는 겹칠 수 없고(어느 뜻인지 모름), 테이블 용어는 한 DB에 같은 이름의 테이블이 둘일 수 없으니 겹칠 수 없다.
 */
const mayShareName = (a: Pick<DictTerm, 'kind' | 'logical'>, b: Pick<DictTerm, 'kind' | 'logical'>) => !isTable(a) && !isTable(b) && Boolean(a.logical.trim() && b.logical.trim());

// ── 물리명 표기 ──────────────────────────────────────────

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
export function detectStyle(terms: Pick<DictTerm, 'logical' | 'physical'>[], required?: NameStyle | null): StyleCheck {
  if (required) return { style: required, offenders: terms.filter((t) => !fitsStyle(t.physical, required)) as DictTerm[] };
  if (!terms.length) return { style: null, offenders: [] };
  const styles: NameStyle[] = ['snake', 'SNAKE', 'camel'];
  const fits = styles.map((s) => terms.filter((t) => fitsStyle(t.physical, s)).length);
  const style = styles[fits.indexOf(Math.max(...fits))];
  return { style, offenders: terms.filter((t) => !fitsStyle(t.physical, style)) as DictTerm[] };
}

/** 테이블 용어·컬럼 용어를 따로 판단한다 (기준을 정한 쪽은 그 표기로 본다) */
export function detectTermStyles(terms: DictTerm[], saved?: NamingSetting | null): Record<NameKind, StyleCheck> {
  return {
    table: detectStyle(terms.filter(isTable), saved?.table),
    column: detectStyle(terms.filter((t) => !isTable(t)), saved?.column),
  };
}

/** 프로젝트에 저장한 이름 표기 기준 (없으면 null — 사전 용어들로 판단) */
export function savedNamingStyle(doc: Y.Doc): NamingSetting | null {
  return readMeta(doc).namingStyle ?? null;
}

const termLabel = (t: Pick<DictTerm, 'logical' | 'physical' | 'kind'>) => `${isTable(t) ? '[테이블] ' : ''}${t.logical.trim() ? `${t.logical}=${t.physical}` : t.physical}`;

/** 섞였거나 기준과 다를 때 사람에게 보일 안내 (테이블·컬럼 따로) */
export function termStylesMessage(checks: Record<NameKind, StyleCheck>, saved: NamingSetting | null): string {
  return (['table', 'column'] as NameKind[])
    .filter((k) => checks[k].offenders.length)
    .map((k) => `${NAME_KIND_LABEL[k]} 용어: ${mixedStyleMessage(checks[k], !!saved?.[k])}`)
    .join('\n');
}

/** 섞였을 때 사람에게 보일 안내 */
export function mixedStyleMessage(check: StyleCheck, saved = false): string {
  const list = check.offenders.slice(0, 10).map(termLabel).join(', ');
  if (saved) return `이 프로젝트의 이름 표기 기준은 ${NAME_STYLE_LABEL[check.style!]}입니다. 다른 표기의 용어가 ${check.offenders.length}개 있습니다 (${list}${check.offenders.length > 10 ? ' …' : ''}). 기준대로 고치거나, 위쪽 표기 배지에서 기준을 바꾸세요.`;
  return `물리명 표기가 섞여 있습니다. 대부분 ${NAME_STYLE_LABEL[check.style!]}인데 다른 표기가 ${check.offenders.length}개 있습니다 (${list}${check.offenders.length > 10 ? ' …' : ''}). snake_case·camelCase 등 한 가지로 맞춰 주세요.`;
}

/** 같은 물리명을 쓰는 용어 묶음 (같은 구분 안에서. 서로 다른 용어가 같은 물리명이면 사전에서 헷갈린다) */
export function duplicatePhysicals(terms: DictTerm[]): DictTerm[][] {
  const by = new Map<string, DictTerm[]>();
  for (const t of terms) by.set(scopedPhysical(t), [...(by.get(scopedPhysical(t)) ?? []), t]);
  // 각자 논리명이 있는 컬럼 용어끼리는 같은 물리명을 써도 된다
  return [...by.values()].filter((g) => g.length > 1 && g.some((a, i) => g.some((b, j) => i !== j && !mayShareName(a, b))));
}

/** 논리명이 다른 컬럼 용어끼리 같은 물리명을 쓰는 묶음 (막지는 않고 경고만: 같은 뜻이 아닌지 확인) */
export function sharedPhysicals(terms: DictTerm[]): DictTerm[][] {
  const by = new Map<string, DictTerm[]>();
  for (const t of terms) if (!isTable(t) && t.logical.trim()) by.set(physicalKey(t.physical), [...(by.get(physicalKey(t.physical)) ?? []), t]);
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
  const namingStyle = savedNamingStyle(doc);
  return { terms, updatedAt: (root.get('updatedAt') as string | undefined) ?? undefined, ...(namingStyle ? { namingStyle } : {}) };
}

const cleanTerm = (t: DictTerm): DictTerm | null => {
  const physical = t.physical?.trim();
  if (!physical) return null;
  const out: DictTerm = { ...(isTable(t) ? { kind: 'table' as const } : {}), logical: t.logical?.trim() ?? '', physical };
  if (!isTable(t) && t.type?.trim()) out.type = t.type.trim().toUpperCase();
  if (!isTable(t) && t.length?.toString().trim()) out.length = t.length.toString().trim();
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
  const saved = savedNamingStyle(doc);
  const checks = detectTermStyles(mergedTerms(allTerms(doc), input.terms, mode), saved);
  if (checks.table.offenders.length || checks.column.offenders.length) throw new Error(termStylesMessage(checks, saved));
  const terms = termsMap(doc);
  if (mode === 'replace') terms.clear();
  let n = 0;
  for (const raw of input.terms) {
    const term = cleanTerm(raw);
    if (!term) continue;
    // 논리명을 채운 용어가 들어오면, 같은 물리명의 논리명 없던 용어는 그것으로 바뀐다
    if (term.logical) terms.delete(termKey({ kind: term.kind, logical: '', physical: term.physical }));
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
export function setDictEntry(doc: Y.Doc, entry: DictTerm, previous?: Pick<DictTerm, 'logical' | 'physical' | 'kind'>): void {
  const clean = cleanTerm(entry);
  if (!clean) throw new Error('물리명을 입력하세요');
  const map = termsMap(doc);
  const prevKey = previous ? termKey(previous) : null;
  const others = allTerms(doc).filter((t) => termKey(t) !== prevKey && termKey(t) !== termKey(clean));
  const saved = savedNamingStyle(doc);
  const kind: NameKind = isTable(clean) ? 'table' : 'column';
  const { style } = detectStyle(others.filter((t) => isTable(t) === isTable(clean)), saved?.[kind]);
  if (style && !fitsStyle(clean.physical, style)) {
    throw new Error(`${saved?.[kind] ? `이 프로젝트의 ${NAME_KIND_LABEL[kind]} 이름 표기 기준은` : `이 사전의 ${NAME_KIND_LABEL[kind]} 용어는`} ${NAME_STYLE_LABEL[style]}입니다. "${clean.physical}" 대신 "${toStyle(clean.physical, style)}"처럼 입력하세요.`);
  }
  // 같은 구분(테이블/컬럼) 안에서 겹치면 막는다. 논리명 없던 같은 물리명 용어에 논리명을 채우는 것은 같은 용어로 본다.
  // 논리명이 다른 컬럼 용어끼리는 같은 물리명을 써도 된다 (논리명이 같은 것만 막는다)
  const kindName = isTable(clean) ? '테이블' : '컬럼';
  // 새로 넣을 때 같은 용어가 이미 있으면 덮어쓰지 않는다 (고치려면 목록에서 그 줄을 고친다)
  const existing = !previous ? (map.get(termKey(clean)) as DictTerm | undefined) : undefined;
  if (existing) throw new Error(`${kindName} 논리명 "${existing.logical || existing.physical}"은(는) 이미 ${existing.physical}(으)로 사전에 있습니다 — 바꾸려면 목록에서 그 줄을 고치세요.`);
  const same = others.find((t) => scopedPhysical(t) === scopedPhysical(clean) && !(clean.logical && !t.logical) && !mayShareName(t, clean));
  if (same) throw new Error(`${kindName} 물리명 ${clean.physical}은(는) 이미 ${same.logical ? `"${same.logical}"(으)로` : '(논리명 없이)'} 사전에 있습니다.`);
  const sameLogical = clean.logical && others.find((t) => isTable(t) === isTable(clean) && t.logical && dictKey(t.logical) === dictKey(clean.logical));
  if (sameLogical) throw new Error(`${kindName} 논리명 "${clean.logical}"은(는) 이미 ${sameLogical.physical}(으)로 사전에 있습니다.`);
  if (prevKey && prevKey !== termKey(clean)) map.delete(prevKey);
  if (clean.logical) map.delete(termKey({ kind: clean.kind, logical: '', physical: clean.physical }));
  map.set(termKey(clean), clean);
  dictMap(doc).set('updatedAt', new Date().toISOString());
}

export function removeDictEntry(doc: Y.Doc, term: Pick<DictTerm, 'logical' | 'physical' | 'kind'>): void {
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
  /** 논리명 → 컬럼 용어 (논리명이 있는 것만) */
  terms: Map<string, DictTerm>;
  /** 물리명(대소문자 무시) → 컬럼 용어 */
  byPhysical: Map<string, DictTerm>;
  /** 테이블 용어: 논리명 → 용어, 물리명 → 용어 */
  tables: Map<string, DictTerm>;
  tablesByPhysical: Map<string, DictTerm>;
  /** 사전의 물리명 표기 (테이블 용어·컬럼 용어 따로) */
  styles: NamingStyles;
}

const indexCache = new WeakMap<Dictionary, DictIndex>();

const termStyles = (dict: Dictionary): NamingStyles => {
  const checks = detectTermStyles(dict.terms, dict.namingStyle);
  return { table: checks.table.style, column: checks.column.style };
};

export function dictIndex(dict: Dictionary): DictIndex {
  const cached = indexCache.get(dict);
  if (cached) return cached;
  const columns = dict.terms.filter((t) => !isTable(t));
  const tableTerms = dict.terms.filter(isTable);
  const byLogical = (list: DictTerm[]) => new Map(list.filter((t) => t.logical).map((t) => [dictKey(t.logical), t]));
  // 같은 물리명이면 논리명이 있는 용어가 먼저. 여러 용어가 같은 물리명을 쓰면(결제상태·구독상태 → status) 물리명만으로는 어느 용어인지 모르니 넣지 않는다
  const byPhys = (list: DictTerm[]) => {
    const m = new Map<string, DictTerm>();
    const shared = new Set<string>();
    for (const t of [...list].sort((a, b) => Number(!a.logical) - Number(!b.logical))) {
      const key = physicalKey(t.physical);
      const first = m.get(key);
      if (!first) m.set(key, t);
      else if (first.logical && t.logical) shared.add(key);
    }
    for (const key of shared) m.delete(key);
    return m;
  };
  const index = { dict, terms: byLogical(columns), byPhysical: byPhys(columns), tables: byLogical(tableTerms), tablesByPhysical: byPhys(tableTerms), styles: termStyles(dict) };
  indexCache.set(dict, index);
  return index;
}

const asIndex = (dict: Dictionary | DictIndex) => ('byPhysical' in dict ? dict : dictIndex(dict));

/** 사전의 물리명 표기 (용어가 없으면 null) */
export function dictionaryStyles(dict: Dictionary | DictIndex | null | undefined): NamingStyles | null {
  return dict ? asIndex(dict).styles : null;
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
    if (isTable(t) || (by === 'logical' && !t.logical)) continue;
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
export function styleSuggestion(dict: Dictionary | DictIndex | null | undefined, name: string, kind: NameKind = 'column'): { style: NameStyle; suggestion: string } | null {
  const style = dictionaryStyles(dict)?.[kind];
  if (!style || !name.trim() || fitsStyle(name, style)) return null;
  return { style, suggestion: toStyle(name, style) };
}

export interface TableDictCheck {
  status: 'ok' | 'mismatch' | 'unknown';
  /** 사전의 표준 물리명 (mismatch) */
  physical?: string;
}

/**
 * 테이블이 사전을 따르는지 (물리명만 본다). 논리명이 없으면 null.
 * 논리명은 사전에 없지만 같은 물리명이 논리명 없이 테이블 용어로 있으면 사전에 있는 것으로 본다.
 */
export function checkTableAgainstDictionary(dict: Dictionary | DictIndex | null | undefined, table: { name: string; logicalName: string }): TableDictCheck | null {
  if (!dict || !table.logicalName.trim()) return null;
  const index = asIndex(dict);
  const term = index.tables.get(dictKey(table.logicalName));
  if (!term) {
    const owner = index.tablesByPhysical.get(physicalKey(table.name));
    return owner && !owner.logical ? { status: 'ok' } : { status: 'unknown' };
  }
  return term.physical === table.name.trim() ? { status: 'ok' } : { status: 'mismatch', physical: term.physical };
}

/** 테이블 물리명으로 사전 테이블 용어 찾기 */
export function lookupTablePhysical(dict: Dictionary | DictIndex | null | undefined, physical: string): DictTerm | null {
  if (!dict || !physical.trim()) return null;
  return asIndex(dict).tablesByPhysical.get(physicalKey(physical)) ?? null;
}

/** 테이블 → 사전 용어 */
export const termFromTable = (t: { name: string; logicalName: string; comment: string }): DictTerm => ({
  kind: 'table',
  logical: t.logicalName.trim(),
  physical: t.name.trim(),
  ...(t.comment?.trim() ? { description: t.comment.trim() } : {}),
});

/**
 * 테이블들 중 사전에 넣을 수 있는 새 테이블 용어 (컬럼과 같은 규칙: 사전에 없는 논리명, 사전 표기에 맞고, 같은 물리명이 사전에 없는 것)
 */
export function newTableTerms(dict: Dictionary | DictIndex, tables: { name: string; logicalName: string; comment: string }[]): { add: DictTerm[]; skipped: { where: string; reason: string }[] } {
  const index = asIndex(dict);
  const add: DictTerm[] = [];
  const skipped: { where: string; reason: string }[] = [];
  for (const t of tables) {
    if (!t.logicalName.trim()) continue;
    const r = checkTableAgainstDictionary(index, t);
    const owner = index.tablesByPhysical.get(physicalKey(t.name));
    const fill = owner && !owner.logical;
    if (r?.status !== 'unknown' && !fill) continue;
    const style = styleSuggestion(index, t.name, 'table');
    if (style) {
      skipped.push({ where: `테이블 ${t.name}`, reason: `이름 표기 기준(${NAME_STYLE_LABEL[style.style]})과 다릅니다 — ${style.suggestion}(으)로 바꾸세요` });
      continue;
    }
    if (owner && !fill) {
      skipped.push({ where: `테이블 ${t.name}`, reason: `테이블 물리명 ${t.name}은(는) 사전에 "${owner.logical}"(으)로 있습니다 — 논리명을 "${owner.logical}"(으)로 쓰세요` });
      continue;
    }
    if (add.some((x) => dictKey(x.logical) === dictKey(t.logicalName) || physicalKey(x.physical) === physicalKey(t.name))) continue;
    add.push(termFromTable(t));
  }
  return { add, skipped };
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
      skipped.push({ where, reason: `이름 표기 기준(${NAME_STYLE_LABEL[style.style]})과 다릅니다 — ${style.suggestion}(으)로 바꾸세요` });
      continue;
    }
    // 사전에 같은 물리명이 다른 논리명으로 있어도 넣는다 (논리명이 다르면 같은 물리명을 써도 된다)
    if (add.some((x) => dictKey(x.logical) === dictKey(c.logicalName))) continue;
    add.push(termFromColumn(c));
  }
  return { add, skipped };
}

/**
 * AI가 바꾼 뒤 사전과 맞추기: 이번에 새로 만들거나 고친 컬럼 중
 * - 사전과 다른 것 → 고치라는 안내 (표기 기준과 다른 이름은 naming.ts의 namingNotes가 알린다)
 * - 사전에 없는 용어 → 사전에 넣을 용어 (같은 논리명·물리명이 이미 있거나 이번에 이미 넣은 것은 빼고)
 * 사전이 없으면 아무것도 하지 않는다.
 */
export function syncDictionaryForAi(
  dict: Dictionary | null | undefined,
  before: { tables: { id: string; columns: Column[] }[] },
  after: { tables: { id: string; name: string; logicalName?: string; comment?: string; columns: Column[] }[] },
  limit = 30,
): { add: DictTerm[]; notes: string[] } {
  if (!dict?.terms.length) return { add: [], notes: [] };
  const index = dictIndex(dict);
  const prev = new Map(before.tables.flatMap((t) => t.columns.map((c) => [c.id, c] as const)));
  const changed: { table: string; column: Column }[] = [];
  const notes: string[] = [];
  for (const t of after.tables) {
    if (isToolTable(t.name)) continue;
    for (const c of t.columns) {
      const old = prev.get(c.id);
      if (old && old.name === c.name && old.logicalName === c.logicalName && old.type === c.type && old.length === c.length) continue;
      const r = checkColumnAgainstDictionary(index, c);
      if (r?.status === 'mismatch') {
        notes.push(`${t.name}.${c.name}: "${c.logicalName}"의 표준은 ${describeMatch(r.match!)} — updateColumn으로 맞추세요`);
        continue;
      }
      changed.push({ table: t.name, column: c });
    }
  }
  // 테이블: 새로 만들었거나 이름·논리명을 바꾼 것
  const prevTables = new Map(before.tables.map((t) => [t.id, t] as const));
  const changedTables = after.tables.filter((t) => {
    if (isToolTable(t.name)) return false;
    const old = prevTables.get(t.id) as { name?: string; logicalName?: string } | undefined;
    return !old || old.name !== t.name || old.logicalName !== (t as { logicalName?: string }).logicalName;
  }) as { id: string; name: string; logicalName: string; comment: string }[];
  for (const t of changedTables) {
    const r = checkTableAgainstDictionary(index, t);
    if (r?.status === 'mismatch') notes.push(`테이블 ${t.name}: "${t.logicalName}"의 표준 테이블 물리명은 ${r.physical} — updateTable로 맞추세요`);
  }
  const columnsResult = newTermsFromColumns(index, changed);
  const tablesResult = newTableTerms(index, changedTables.filter((t) => t.logicalName !== undefined));
  const add = [...tablesResult.add, ...columnsResult.add];
  notes.push(...[...tablesResult.skipped, ...columnsResult.skipped].map((s) => `${s.where}: ${s.reason}${s.reason.startsWith('이름 표기 기준') ? ' (그래서 사전에 넣지 않았습니다)' : ''}`));
  return { add, notes: notes.length > limit ? [...notes.slice(0, limit), `… 외 ${notes.length - limit}개`] : notes };
}

/**
 * 사전에 용어 여러 개를 더한다 (같은 논리명·물리명이 이미 있으면 건너뜀). 더한 용어.
 * 같은 물리명이 논리명 없이 있으면 그 용어에 논리명을 채운다.
 */
export function addMissingTerms(doc: Y.Doc, terms: DictTerm[]): DictTerm[] {
  const map = termsMap(doc);
  const existing = allTerms(doc);
  const logicalKey = (t: DictTerm) => `${isTable(t) ? 't:' : ''}${dictKey(t.logical)}`;
  const logicals = new Set(existing.filter((t) => t.logical).map(logicalKey));
  const physicals = new Map(existing.map((t) => [scopedPhysical(t), t] as const));
  const added: DictTerm[] = [];
  for (const raw of terms) {
    const t = cleanTerm(raw);
    if (!t || (t.logical && logicals.has(logicalKey(t)))) continue;
    const owner = physicals.get(scopedPhysical(t));
    if (owner && !mayShareName(owner, t) && (owner.logical || !t.logical)) continue;
    // 논리명 없던 같은 물리명 용어에는 논리명을 채운다 (각자 논리명이 있으면 둘 다 둔다)
    if (owner && !owner.logical) map.delete(termKey(owner));
    map.set(termKey(t), t);
    if (t.logical) logicals.add(logicalKey(t));
    physicals.set(scopedPhysical(t), t);
    added.push(t);
  }
  if (added.length) dictMap(doc).set('updatedAt', new Date().toISOString());
  return added;
}

/** 논리명이 없는 사전 용어에, 같은 물리명을 쓰는 ERD 컬럼의 논리명을 채울 수 있는 것 */
export function logicalFillsFromSchema(dict: Dictionary, schema: { tables: { name?: string; logicalName?: string; columns: Column[] }[] }): DictTerm[] {
  const emptyTables = new Map(dict.terms.filter((t) => !t.logical && isTable(t)).map((t) => [physicalKey(t.physical), t] as const));
  const empty = new Map(dict.terms.filter((t) => !t.logical && !isTable(t)).map((t) => [physicalKey(t.physical), t] as const));
  if (!empty.size && !emptyTables.size) return [];
  const takenTables = new Set(dict.terms.filter((t) => t.logical && isTable(t)).map((t) => dictKey(t.logical)));
  const tableFills: DictTerm[] = [];
  for (const t of schema.tables) {
    const term = t.name ? emptyTables.get(physicalKey(t.name)) : undefined;
    if (!term || !t.logicalName?.trim() || takenTables.has(dictKey(t.logicalName))) continue;
    tableFills.push({ ...term, logical: t.logicalName.trim() });
    takenTables.add(dictKey(t.logicalName));
  }
  const taken = new Set(dict.terms.filter((t) => t.logical && !isTable(t)).map((t) => dictKey(t.logical)));
  const out = new Map<string, DictTerm>();
  for (const t of schema.tables) {
    for (const c of t.columns) {
      const term = empty.get(physicalKey(c.name));
      if (!term || !c.logicalName.trim() || out.has(physicalKey(c.name)) || taken.has(dictKey(c.logicalName))) continue;
      out.set(physicalKey(c.name), { ...term, logical: c.logicalName.trim() });
      taken.add(dictKey(c.logicalName));
    }
  }
  return [...tableFills, ...out.values()];
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
export function dictionaryFromSchema(schema: { tables: { name: string; logicalName?: string; comment?: string; columns: Column[] }[] }): DictDraftRow[] {
  const groups = new Map<string, { logicals: Map<string, number>; comments: Map<string, number>; variants: Map<string, DictVariant> }>();
  // 도구가 만든 테이블(_prisma_migrations 등)은 사전에 넣지 않는다
  const tables = schema.tables.filter((t) => !isToolTable(t.name));
  for (const t of tables) {
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
  // 테이블 용어: 논리명이 같은 테이블은 묶는다 (같은 논리명을 다른 테이블이 쓰면 variants)
  const tableGroups = new Map<string, DictDraftRow>();
  for (const t of tables) {
    const logical = t.logicalName?.trim() ?? '';
    const key = logical ? dictKey(logical) : `@${physicalKey(t.name)}`;
    const row = tableGroups.get(key);
    if (row) {
      row.variants.push({ physical: t.name, type: '', length: '', columns: [t.name] });
      continue;
    }
    tableGroups.set(key, { kind: 'table', logical, physical: t.name, ...(t.comment?.trim() ? { description: t.comment.trim() } : {}), variants: [{ physical: t.name, type: '', length: '', columns: [t.name] }] });
  }
  const order = (a: DictDraftRow, b: DictDraftRow) => Number(!a.logical) - Number(!b.logical) || a.logical.localeCompare(b.logical) || a.physical.localeCompare(b.physical);
  return [...[...tableGroups.values()].sort(order), ...rows.sort(order)];
}

// ── 용어 겹침 (사전 넣기 화면과 AI 편집이 같이 쓴다) ──────────────────────────────

export interface TermOverlap {
  kind: NameKind;
  /** 겹치는 논리명 */
  value: string;
  /** 겹치는 줄들의 위치 (입력 배열의 index) */
  indexes: number[];
}

/**
 * 용어 목록에서 겹치는 것: 같은 구분(테이블/컬럼) 안에서 논리명이 같은 줄이 여럿인 것.
 * 사전은 논리명으로 용어를 찾으므로 같은 논리명(= 같은 뜻)은 한 물리명이어야 한다.
 * 물리명만 같은 것은 겹침이 아니다 (결제상태·구독상태 → status처럼 테이블 이름이 뜻을 보충하는 설계도 흔하다). 논리명이 빈 줄은 보지 않는다.
 */
export function termOverlaps(terms: Pick<DictTerm, 'kind' | 'logical'>[]): TermOverlap[] {
  const groups = new Map<string, TermOverlap>();
  terms.forEach((t, i) => {
    if (!t.logical.trim()) return;
    const key = `${t.kind === 'table' ? 't:' : ''}${dictKey(t.logical)}`;
    const g = groups.get(key) ?? { kind: t.kind === 'table' ? 'table' : 'column', value: t.logical.trim(), indexes: [] };
    groups.set(key, g);
    g.indexes.push(i);
  });
  return [...groups.values()].filter((g) => g.indexes.length > 1);
}

/** 사전에 넣기 전 검사 결과 (줄 번호는 입력 rows의 index) */
export interface DraftCheck {
  /** 넣은 뒤 사전의 표기 (테이블·컬럼 따로) */
  styles: NamingStyles;
  /** 그 표기와 다른 물리명의 줄 */
  styleOff: number[];
  /** 겹치는 줄: 같은 논리명이 여러 줄이거나, 넣은 뒤 사전에서 테이블·논리명 없는 용어의 물리명이 겹침 */
  dup: number[];
  /** 같은 논리명을 ERD에서 여러 물리명으로 쓴 줄 ("다르게 쓴 곳", 넣는 것은 막지 않음) */
  variants: number[];
  /** 논리명이 다른 용어와 물리명이 같은 줄 (경고만, 넣는 것은 막지 않음. 예: 결제상태·구독상태 → status) */
  shared: number[];
}

/**
 * 사전에 넣기 전 검사 — 사전 화면의 "넣을 용어" 목록과 AI 편집 검사(erdTermNotes)가 같이 쓰는 하나의 규칙.
 * 이 규칙을 바꾸면 두 곳에 함께 적용된다. 표기(styleOff)나 겹침(dup)이 있으면 사전 화면은 넣지 않는다.
 * current: 지금 사전, mode: 합치기(merge)면 지금 사전과 함께 본다.
 */
export function checkDictDraft(
  rows: (DictTerm & { variants?: DictVariant[] })[],
  current: DictTerm[],
  saved: NamingSetting | null | undefined,
  mode: 'replace' | 'merge',
): DraftCheck {
  const terms = rows.map(({ variants: _v, ...t }) => t as DictTerm);
  const result = mergedTerms(current, terms, current.length ? mode : 'replace');
  const checks = detectTermStyles(result, saved);
  const offKeys = new Set([...checks.table.offenders, ...checks.column.offenders].map((t) => termKey(t)));
  const physDup = new Set(duplicatePhysicals(result).flatMap((g) => g.map((t) => scopedPhysical(t))));
  const logicalDup = new Set(termOverlaps(terms).flatMap((g) => g.indexes));
  const sharedKeys = new Set(sharedPhysicals(result).map((g) => physicalKey(g[0].physical)));
  const idx = (pred: (t: DictTerm, i: number) => boolean) => terms.flatMap((t, i) => (t.physical.trim() && pred(t, i) ? [i] : []));
  return {
    styles: { table: checks.table.style, column: checks.column.style },
    styleOff: idx((t) => offKeys.has(termKey(t))),
    dup: idx((t, i) => physDup.has(scopedPhysical(t)) || logicalDup.has(i)),
    variants: rows.flatMap((r, i) => ((r.variants?.length ?? 0) > 1 ? [i] : [])),
    shared: idx((t, i) => !isTable(t) && Boolean(t.logical.trim()) && sharedKeys.has(physicalKey(t.physical)) && !logicalDup.has(i)),
  };
}

export interface ErdTermNote {
  /** 테이블.컬럼 (테이블이면 테이블 이름) */
  where: string;
  message: string;
}

/**
 * AI가 바꾼 뒤: 지금 ERD로 사전 화면의 "ERD에서 만들기"를 했을 때 나올 문제를 미리 알린다 (사전이 없어도).
 * ERD에서 사전 초안을 만드는 것(dictionaryFromSchema)과 넣기 전 검사(checkDictDraft)를 사전 화면과 똑같이 쓴다 —
 * 그래서 AI가 만든 ERD는 사전에 그대로 넣을 수 있고, 사전 규칙을 바꾸면 이 검사도 같이 바뀐다.
 * 사전이 있으면 화면의 기본(합치기)처럼 지금 사전과 함께 본다. 이번에 새로 만들거나 이름·논리명을 바꾼 곳만 알린다.
 */
export function erdTermNotes(
  before: { tables: { id: string; name: string; logicalName?: string; columns: Column[] }[] },
  after: { tables: { id: string; name: string; logicalName?: string; comment?: string; columns: Column[] }[] },
  options: { dictionary?: Dictionary | null; saved?: NamingSetting | null; limit?: number } = {},
): ErdTermNote[] {
  const prevTables = new Map(before.tables.map((t) => [t.id, t] as const));
  const prevColumns = new Map(before.tables.flatMap((t) => t.columns.map((c) => [c.id, c] as const)));
  // 이번에 바뀐 곳 (테이블.컬럼 / t:테이블)
  const touched = new Set<string>();
  for (const t of after.tables) {
    if (isToolTable(t.name)) continue;
    const old = prevTables.get(t.id);
    const renamed = !old || old.name !== t.name;
    if (renamed || (old.logicalName ?? '') !== (t.logicalName ?? '')) touched.add(`t:${t.name}`);
    for (const c of t.columns) {
      const o = prevColumns.get(c.id);
      if (renamed || !o || o.name !== c.name || o.logicalName !== c.logicalName) touched.add(`${t.name}.${c.name}`);
    }
  }
  if (!touched.size) return [];
  const rows = dictionaryFromSchema(after);
  // shared(논리명이 다른데 물리명이 같음)는 사전 화면에서도 경고만이고, AI에게는 고치라고 하지 않는다 (테이블 이름이 뜻을 보충하는 설계)
  const check = checkDictDraft(rows, options.dictionary?.terms ?? [], options.saved ?? options.dictionary?.namingStyle, 'merge');
  const placeOf = (r: DictDraftRow, physical?: string) =>
    r.variants.filter((v) => physical === undefined || v.physical === physical).flatMap((v) => v.columns).map((x) => (r.kind === 'table' ? `t:${x}` : x));
  const show = (place: string) => (place.startsWith('t:') ? `테이블 ${place.slice(2)}` : place);
  const notes: ErdTermNote[] = [];
  const seen = new Set<string>();
  const push = (place: string, message: string) => {
    const text = `${show(place)}: ${message}`;
    if (seen.has(text)) return;
    seen.add(text);
    notes.push({ where: show(place), message: text });
  };
  for (const i of check.styleOff) {
    const r = rows[i];
    const style = check.styles[isTable(r) ? 'table' : 'column'];
    for (const place of placeOf(r, r.physical).filter((p) => touched.has(p))) push(place, `용어 사전 표기(${style ? NAME_STYLE_LABEL[style] : ''})와 다릅니다${style ? ` — ${toStyle(r.physical, style)}(으)로 바꾸세요` : ''}`);
  }
  for (const i of check.dup) {
    const r = rows[i];
    const reason = !r.logical.trim() ? '논리명이 없는데 같은 물리명을 다른 용어가 씁니다 — 논리명을 넣으세요' : '같은 물리명의 용어가 사전에 이미 있어 사전에 넣을 수 없습니다 — 물리명이나 논리명을 구분하세요';
    for (const place of placeOf(r).filter((p) => touched.has(p))) push(place, reason);
  }
  const typeText = (v: Pick<DictVariant, 'type' | 'length'>) => `${v.type || '(타입 없음)'}${v.length ? `(${v.length})` : ''}`;
  for (const i of check.variants) {
    const r = rows[i];
    const main = r.variants[0];
    // 이름은 같은데 타입·길이가 다른 곳
    for (const v of r.variants.slice(1).filter((x) => x.physical === main.physical)) {
      for (const place of v.columns.filter((p) => touched.has(p))) {
        push(place, `같은 논리명 "${r.logical || r.physical}"을(를) ${main.columns.slice(0, 3).join(', ')}에서는 ${typeText(main)}(으)로 씁니다 — 같은 뜻이면 타입·길이를 맞추세요 (지금 ${typeText(v)})`);
      }
    }
    // 가장 많이 쓰는 물리명(사전 초안의 기본)으로 맞추라고. 이번에 그 이름과 다르게 만든 곳만
    for (const v of r.variants.filter((x) => x.physical !== r.physical)) {
      for (const place of placeOf(r, v.physical).filter((p) => touched.has(p))) {
        push(place, `같은 논리명 "${r.logical}"을(를) ${placeOf(r, r.physical).slice(0, 3).map(show).join(', ')}에서는 ${r.physical}(으)로 씁니다 — 같은 뜻이면 물리명을 ${r.physical}(으)로 맞추고, 다른 뜻이면 논리명을 구분하세요`);
      }
    }
    // 이번에 만든 이름이 다수가 되어 기본이 되었으면, 다르게 쓰던 기존 곳을 알린다
    const mine = placeOf(r, r.physical).filter((p) => touched.has(p));
    const other = r.variants.find((x) => x.physical !== r.physical);
    if (other && mine.length && r.variants.every((x) => x.physical === r.physical || !placeOf(r, x.physical).some((p) => touched.has(p)))) {
      push(mine[0], `같은 논리명 "${r.logical}"을(를) ${placeOf(r, other.physical).slice(0, 3).map(show).join(', ')}에서는 ${other.physical}(으)로 씁니다 — 같은 뜻이면 한 물리명으로 맞추고, 다른 뜻이면 논리명을 구분하세요`);
    }
  }
  const limit = options.limit ?? 20;
  return notes.length > limit ? [...notes.slice(0, limit), { where: '', message: `… 외 ${notes.length - limit}개` }] : notes;
}
