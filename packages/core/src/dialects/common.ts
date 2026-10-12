import { checkName, findColumn, findTable, type CheckConstraint, type Column, type Index, type Relation, type Schema, type Table } from '../model';
import type { Dialect } from './types';

/** SQL 문자열 리터럴 */
export function literal(value: string, escapeBackslash = false): string {
  let v = value.replace(/'/g, "''");
  if (escapeBackslash) v = v.replace(/\\/g, '\\\\');
  return `'${v}'`;
}

/** SQL에 들어갈 코멘트. 설명이 없으면 논리명을 쓴다 (국내 실무 관례). */
/** DB comment에 넣는 값: 논리명. 설명(comment)은 ERD에서만 보는 상세 설명이라 DB에 넣지 않는다 */
export function sqlComment(item: { comment: string; logicalName: string }): string {
  return item.logicalName.trim();
}

export function columnNames(table: Table, ids: string[]): string[] {
  return ids.map((id) => findColumn(table, id)?.name ?? id);
}

/** CREATE INDEX ... ON 테이블 ( 여기 ): 식 인덱스면 식 원문, 아니면 컬럼 이름들 */
export function indexKeys(table: Table, index: Index, q: (name: string) => string): string {
  return index.expression?.trim() ? quoteExpression(index.expression.trim(), q) : columnNames(table, index.columnIds).map(q).join(', ');
}

/** 식 안의 MySQL 백틱 이름(`col`)을 이 DB의 표기로 바꾼다 (PostgreSQL·Oracle "col", SQL Server [col]). MySQL은 그대로 */
export function quoteExpression(expression: string, q: (name: string) => string): string {
  return expression.replace(/`([^`]+)`/g, (_m, name: string) => q(name));
}

/** 괄호·따옴표 밖의 콤마로 나눈다 */
export function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = '';
  let current = '';
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
    } else if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
    } else if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

/** 이 DB에서 지원하지 않는 인덱스 기능이 있으면 주의 문구 (SQL 미리보기·내보내기에 "-- 주의:"로 붙는다) */
export function indexWarnings(dialect: Dialect, table: Table, index: Index): string | undefined {
  const { features, label } = dialect;
  const messages: string[] = [];
  const expression = index.expression?.trim();
  if (expression && !features.expressionIndex) messages.push(`${label}는 식 인덱스를 지원하지 않습니다 (계산 컬럼을 만들어 인덱스를 거세요)`);
  else if (expression) {
    const warn = features.expressionIndex?.warn?.(expression);
    if (warn) messages.push(warn);
  }
  if (index.where?.trim() && !features.partialIndex) messages.push(`${label}는 부분 인덱스를 지원하지 않아 조건(WHERE ${index.where.trim()})을 빼고 만듭니다`);
  const method = index.method?.trim().toLowerCase();
  if (method && method !== 'btree' && !(features.indexMethods?.methods ?? []).includes(method)) messages.push(`${label}에는 ${method} 방식이 없어 일반 인덱스로 만듭니다`);
  if (dialect.traits.noJsonColumnIndex && !expression) {
    const json = index.columnIds.map((id) => findColumn(table, id)).filter((c) => c && /^JSONB?$/i.test(c.type.trim()));
    if (json.length) messages.push(`${label}는 JSON 컬럼(${json.map((c) => c!.name).join(', ')})에 일반 인덱스를 만들 수 없습니다`);
  }
  return messages.length ? messages.join(' / ') : undefined;
}

/** 계산 컬럼을 이 DB에서 그대로 만들 수 없으면 주의 문구 */
export function columnWarnings(dialect: Dialect, column: Column): string | undefined {
  const g = column.generated;
  if (!g?.expression.trim()) return undefined;
  const support = dialect.features.generated ?? {};
  if (g.stored && !support.stored) return `${dialect.label}는 저장형(STORED) 계산 컬럼이 없어 VIRTUAL로 만듭니다: ${column.name}`;
  if (!g.stored && !support.virtual) return `${dialect.label}는 VIRTUAL 계산 컬럼이 없어 STORED(값 저장)로 만듭니다: ${column.name}`;
  return undefined;
}


/** 타입 이름 목록 문자열 → Set (공백으로 나눈 단어) */
export const typeWords = (s: string) => new Set(s.trim().split(/\s+/));

/** 안전 검사 SQL: LIMIT으로 세는 DB (MySQL·MariaDB·PostgreSQL) */
export const limitCount = (inner: string, n: number) => `SELECT COUNT(*) AS n FROM (SELECT 1 AS x ${inner} LIMIT ${n}) t`;
/** 숫자 모양 정규식 (공백·부호·소수점 허용) */
export const numericRegex = (integer: boolean) => `^[[:space:]]*-?[0-9]+${integer ? '' : '([.][0-9]+)?'}[[:space:]]*$`;

/** 부분 인덱스 조건 ( WHERE ...) */
export function indexWhere(index: Index): string {
  return index.where?.trim() ? ` WHERE ${index.where.trim()}` : '';
}

export function relationTables(schema: Schema, relation: Relation): { from: Table; to: Table } {
  const from = findTable(schema, relation.fromTableId);
  const to = findTable(schema, relation.toTableId);
  if (!from || !to) throw new Error(`관계 ${relation.id}의 테이블을 찾을 수 없습니다`);
  return { from, to };
}

export function typeWithLength(type: string, length: string): string {
  const t = type.trim().toUpperCase();
  // 따옴표 밖의 공백만 지운다 (ENUM('in progress', 'done')의 값 안 공백은 남긴다)
  const len = length.replace(/\s+(?=([^']*'[^']*')*[^']*$)/g, '');
  if (!len) return t;
  // DECIMAL UNSIGNED + 10,2 → DECIMAL(10,2) UNSIGNED
  const [base, ...modifiers] = t.split(' ').filter(Boolean);
  const isModifier = (m: string) => m === 'UNSIGNED' || m === 'ZEROFILL';
  if (modifiers.length && modifiers.every(isModifier)) return `${base}(${len}) ${modifiers.join(' ')}`;
  return `${t}(${len})`;
}

export function normalizeDefaultCommon(value: string | null): string | null {
  if (value === null) return null;
  const v = value.trim();
  if (v === '') return null;
  if (/^null$/i.test(v)) return null;
  // 함수/키워드는 대소문자 무시
  if (/^[a-z_]+(\(\))?$/i.test(v)) {
    const upper = v.toUpperCase();
    if (upper === 'NOW()' || upper === 'CURRENT_TIMESTAMP()') return 'CURRENT_TIMESTAMP';
    return upper;
  }
  // 숫자는 값으로 비교한다 (DECIMAL 기본값 0을 DB는 0.00으로 돌려준다)
  if (/^[-+]?\d+(\.\d+)?$/.test(v)) return String(Number(v));
  return v;
}
