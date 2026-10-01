import { findColumn, findTable, type Relation, type Schema, type Table } from '../model';

/** SQL 문자열 리터럴 */
export function literal(value: string, escapeBackslash = false): string {
  let v = value.replace(/'/g, "''");
  if (escapeBackslash) v = v.replace(/\\/g, '\\\\');
  return `'${v}'`;
}

/** SQL에 들어갈 코멘트. 설명이 없으면 논리명을 쓴다 (국내 실무 관례). */
export function sqlComment(item: { comment: string; logicalName: string }): string {
  return item.comment.trim() || item.logicalName.trim();
}

export function columnNames(table: Table, ids: string[]): string[] {
  return ids.map((id) => findColumn(table, id)?.name ?? id);
}

export function relationTables(schema: Schema, relation: Relation): { from: Table; to: Table } {
  const from = findTable(schema, relation.fromTableId);
  const to = findTable(schema, relation.toTableId);
  if (!from || !to) throw new Error(`관계 ${relation.id}의 테이블을 찾을 수 없습니다`);
  return { from, to };
}

export function typeWithLength(type: string, length: string): string {
  const t = type.trim().toUpperCase();
  const len = length.replace(/\s+/g, '');
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
  return v;
}
