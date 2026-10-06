// AI 설계 검토: MCP로 연결한 AI가 설계를 검토해 찾은 문제(오류·경고·참고)를 프로젝트에 저장한다.
// ERD 코드의 설계 검사(lint.ts)는 DB에서 실패하는 것처럼 확실한 사실만 보고, 설계 판단·업무 맥락은 AI 검토가 맡는다.
// - 같은 문제(등급·테이블·컬럼·내용)는 같은 id → 사람이 "무시"한 항목은 다음 검토에서도 무시된 채로 남는다.
// - 항목마다 대상 테이블의 모양 지문을 남겨, 그 뒤 사람이 테이블을 고치면 "다시 확인 필요"로 보여 준다.
// - 범위 검토: 검토할 때 "이번에 본 테이블"(scope)을 함께 보내면 그 테이블의 항목만 바꾸고 다른 테이블의 항목은 그대로 둔다.
//   기능을 추가할 때 새로 만들거나 고친 테이블만 검토하면 되고, 기존 지적은 남는다. scope를 안 보내면 ERD 전체 검토.
// - 테이블마다 마지막으로 검토한 모양(reviewed)을 기억해, 그 뒤 바뀐 테이블을 "검토 필요"로 알려 준다.

import type { Schema, Table } from './model';

export type ReviewSeverity = 'error' | 'warning' | 'info';

export interface AiReviewItem {
  id: string;
  severity: ReviewSeverity;
  /** 대상 테이블 물리명 (프로젝트 전체에 대한 것이면 빈 문자열) */
  table: string;
  column?: string;
  message: string;
  /** 고치는 방법 */
  suggestion?: string;
  status: 'open' | 'resolved';
  /** 검토할 때 대상 테이블의 모양 지문 */
  fingerprint: string;
  createdAt: string;
  resolvedAt?: string;
  /** AI가 어떻게 고쳤는지 */
  resolution?: string;
}

export interface AiReview {
  items: AiReviewItem[];
  reviewedAt: string;
  /** 테이블별 마지막 검토 때의 모양 지문 (소문자 이름 → 지문). 지금과 다르면 검토 뒤 바뀐 것 */
  reviewed?: Record<string, string>;
  /** 검토한 AI (MCP 클라이언트 이름) */
  by?: string;
  summary?: string;
}

export interface AiReviewInput {
  severity: ReviewSeverity;
  table?: string;
  column?: string;
  message: string;
  suggestion?: string;
}

/** 화면 표시 상태: 열림 / 다시 확인 필요(대상 테이블이 바뀜) / 해결됨 / 대상 없음(테이블이 지워짐) */
export type AiReviewState = 'open' | 'stale' | 'resolved' | 'missing';

const SEVERITIES: ReviewSeverity[] = ['error', 'warning', 'info'];
const MAX_ITEMS = 200;
const MAX_RESOLVED_KEPT = 100;

function hash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** 같은 문제는 같은 id (검토를 다시 해도 무시 기록이 이어지게) */
export function reviewItemId(severity: ReviewSeverity, table: string, column: string | undefined, message: string): string {
  const norm = (v: string | undefined) => (v ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  return `ai:${hash([severity, norm(table), norm(column), norm(message)].join('|'))}`;
}

const findByName = (schema: Schema, name: string): Table | undefined => schema.tables.find((t) => t.name.toLowerCase() === name.trim().toLowerCase());

/** 대상 테이블의 모양 지문 (컬럼·인덱스·CHECK·관계). 위치·색상·논리명은 빼고 본다 */
export function tableFingerprint(schema: Schema, tableName: string): string {
  if (!tableName.trim()) return '';
  const t = findByName(schema, tableName);
  if (!t) return '';
  const col = (id: string) => t.columns.find((c) => c.id === id)?.name ?? id;
  const shape = {
    columns: t.columns.map((c) => [c.name, c.type, c.length, c.nullable, c.primaryKey, c.unique, c.autoIncrement, c.defaultValue, c.onUpdate ?? '', c.generated?.expression ?? '']),
    indexes: t.indexes.map((i) => [i.name, i.unique, i.columnIds.map(col), i.expression ?? '', i.where ?? '', i.method ?? '']),
    checks: (t.checks ?? []).map((k) => [k.name, k.expression]),
    relations: schema.relations
      .filter((r) => r.fromTableId === t.id || r.toTableId === t.id)
      .map((r) => [schema.tables.find((x) => x.id === r.fromTableId)?.name, schema.tables.find((x) => x.id === r.toTableId)?.name, r.cardinality, r.onDelete, r.onUpdate]),
  };
  return hash(JSON.stringify(shape));
}

/**
 * AI가 보낸 검토 결과로 새 검토를 만든다.
 * 이번 검토의 항목이 지금 열린 항목이 되고, 이전에 해결한 항목은 기록으로 남긴다 (이번에 다시 나오면 다시 열림).
 */
/**
 * scope: 이번에 검토한 테이블 이름들. 주면 그 테이블(과 항목에 나온 테이블)의 이전 항목만 이번 결과로 바꾸고,
 * 다른 테이블의 열린 항목·테이블 지정 없는 전체 의견은 그대로 둔다. 안 주면 ERD 전체를 검토한 것으로 본다.
 */
export function buildReview(
  schema: Schema,
  input: { items: AiReviewInput[]; summary?: string; by?: string; scope?: string[] },
  previous?: AiReview | null,
  now = new Date().toISOString(),
): AiReview {
  if (!Array.isArray(input.items)) throw new Error('items가 필요합니다');
  if (input.items.length > MAX_ITEMS) throw new Error(`검토 항목은 한 번에 ${MAX_ITEMS}개까지 저장할 수 있습니다`);
  const items = new Map<string, AiReviewItem>();
  for (const raw of input.items) {
    if (!SEVERITIES.includes(raw.severity)) throw new Error(`등급은 error, warning, info 중 하나여야 합니다: ${String(raw.severity)}`);
    const message = String(raw.message ?? '').trim();
    if (!message) throw new Error('검토 항목의 내용(message)이 비어 있습니다');
    const tableName = String(raw.table ?? '').trim();
    const table = tableName ? findByName(schema, tableName) : undefined;
    if (tableName && !table) throw new Error(`테이블을 찾을 수 없습니다: ${tableName}`);
    const column = raw.column?.trim() || undefined;
    if (table && column && !table.columns.some((c) => c.name.toLowerCase() === column.toLowerCase())) throw new Error(`컬럼을 찾을 수 없습니다: ${table.name}.${column}`);
    const id = reviewItemId(raw.severity, table?.name ?? '', column, message);
    items.set(id, {
      id,
      severity: raw.severity,
      table: table?.name ?? '',
      column,
      message,
      suggestion: raw.suggestion?.trim() || undefined,
      status: 'open',
      fingerprint: tableFingerprint(schema, table?.name ?? ''),
      createdAt: now,
    });
  }
  // 이번 검토 범위 (소문자 테이블 이름). 전체 검토면 null
  let scope: Set<string> | null = null;
  if (input.scope) {
    scope = new Set();
    for (const name of input.scope) {
      const t = findByName(schema, String(name));
      if (!t) throw new Error(`검토 범위의 테이블을 찾을 수 없습니다: ${String(name)}`);
      scope.add(t.name.toLowerCase());
    }
    for (const i of items.values()) if (i.table) scope.add(i.table.toLowerCase());
  }
  const inScope = (i: AiReviewItem) => (scope ? Boolean(i.table) && scope.has(i.table.toLowerCase()) : true);
  // 범위 밖의 열린 항목은 그대로 둔다 (이번에 다시 나온 것은 새 항목으로)
  const kept = scope ? (previous?.items ?? []).filter((i) => i.status === 'open' && !inScope(i) && !items.has(i.id)) : [];
  const resolved = (previous?.items ?? []).filter((i) => i.status === 'resolved' && !items.has(i.id)).slice(0, MAX_RESOLVED_KEPT);
  // 테이블별 검토한 모양: 전체 검토면 모든 테이블, 범위 검토면 이전 기록 + 이번 범위
  const reviewed: Record<string, string> = scope ? { ...(previous?.reviewed ?? {}) } : {};
  for (const t of schema.tables) if (!scope || scope.has(t.name.toLowerCase())) reviewed[t.name.toLowerCase()] = tableFingerprint(schema, t.name);
  for (const name of Object.keys(reviewed)) if (!findByName(schema, name)) delete reviewed[name];
  return {
    items: [...items.values(), ...kept, ...resolved],
    reviewedAt: now,
    reviewed,
    by: input.by?.trim() || undefined,
    summary: input.summary?.trim() || (scope ? previous?.summary : undefined),
  };
}

/** AI가 고친 항목을 해결됨으로 표시한다 */
export function resolveReviewItems(review: AiReview, ids: string[], resolution: string | undefined, now = new Date().toISOString()): { review: AiReview; resolved: AiReviewItem[]; unknown: string[] } {
  const want = new Set(ids);
  const resolved: AiReviewItem[] = [];
  const items = review.items.map((i) => {
    if (!want.has(i.id) || i.status === 'resolved') return i;
    const next = { ...i, status: 'resolved' as const, resolvedAt: now, resolution: resolution?.trim() || undefined };
    resolved.push(next);
    return next;
  });
  const known = new Set(review.items.map((i) => i.id));
  return { review: { ...review, items }, resolved, unknown: ids.filter((id) => !known.has(id)) };
}

/** 지금 ERD 기준 항목 상태 */
export function reviewItemState(item: AiReviewItem, schema: Schema): AiReviewState {
  if (item.status === 'resolved') return 'resolved';
  if (!item.table) return 'open';
  if (!findByName(schema, item.table)) return 'missing';
  return tableFingerprint(schema, item.table) === item.fingerprint ? 'open' : 'stale';
}

/**
 * 마지막 AI 검토 뒤 새로 생기거나 모양이 바뀐 테이블 (검토가 필요한 것).
 * 검토를 한 번도 안 했으면 null (전체 검토가 필요).
 */
export function unreviewedTables(schema: Schema, review: AiReview | null | undefined): string[] | null {
  if (!review) return null;
  const reviewed = review.reviewed ?? {};
  return schema.tables.filter((t) => reviewed[t.name.toLowerCase()] !== tableFingerprint(schema, t.name)).map((t) => t.name);
}
