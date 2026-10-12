// 사용자 정의 타입 (ENUM): 허용 값 목록에 이름을 붙여 두고 컬럼 타입으로 쓴다. 예) order_status = ('READY', 'PAID', 'CANCELED')
//
// 컬럼은 타입 칸에 ENUM 이름을 적어 참조한다 (대소문자·따옴표·스키마 접두어는 무시하고 찾는다).
// DB별로 만드는 방법이 다르다:
// - PostgreSQL: CREATE TYPE 이름 AS ENUM (...) 을 따로 만들고 컬럼은 그 타입을 쓴다 (값 추가는 ALTER TYPE ... ADD VALUE)
// - MySQL·MariaDB: 타입 객체가 없어 컬럼마다 ENUM('값', ...) 으로 펼친다
// - Oracle·SQL Server: ENUM이 없어 VARCHAR(가장 긴 값 길이)로 만든다 (허용 값은 CHECK 제약으로 걸 수 있음)
// SQL·DB 비교는 diffSchemas가 이 파일의 resolveEnumColumns로 DB에 맞게 펼친 뒤 비교한다.

import type { DialectId } from './dialects/types';
import { newId, type Column, type EnumType, type Schema } from './model';

/** ENUM 이름 비교용 키: 스키마 접두어·따옴표를 빼고 소문자로 ("public"."OrderStatus" → orderstatus) */
export function enumKey(name: string): string {
  const parts = name.trim().split('.');
  return (parts[parts.length - 1] ?? '').replace(/"/g, '').trim().toLowerCase();
}

/** 이 컬럼 타입이 가리키는 ENUM (없으면 undefined). 괄호(길이)가 붙은 타입은 ENUM이 아니다 */
export function enumOfType(enums: EnumType[] | undefined, type: string): EnumType | undefined {
  if (!enums?.length || !type.trim() || /[()]/.test(type)) return undefined;
  const k = enumKey(type);
  return enums.find((e) => enumKey(e.name) === k);
}

export function createEnum(partial: Partial<EnumType> = {}): EnumType {
  return { id: newId('enum'), name: 'new_enum', values: [], ...partial };
}

/** 값 목록 정리: 앞뒤 공백 제거, 빈 값·중복 제거 (순서는 유지) */
export function cleanEnumValues(values: string[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    const t = v.trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

const sqlString = (v: string) => `'${v.replace(/'/g, "''")}'`;

/** MySQL ENUM('a','b') 괄호 안 */
export function enumValueList(values: string[]): string {
  return values.map(sqlString).join(',');
}

/** MySQL ENUM 괄호 안 "'a','b'"를 값 목록으로 */
export function parseEnumValueList(text: string): string[] {
  const out: string[] = [];
  const re = /'((?:[^']|'')*)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(m[1]!.replace(/''/g, "'"));
  return out;
}

/** PostgreSQL에서 쓰는 타입 이름 (소문자 이름이면 그대로, 대문자가 섞이면 따옴표로) */
export function pgEnumTypeName(name: string): string {
  const n = name.trim().replace(/"/g, '');
  return /^[a-z_][a-z0-9_]*$/.test(n) ? n : `"${n}"`;
}

/** 이 ENUM을 쓰는 컬럼 */
export function enumUsages(schema: Pick<Schema, 'tables' | 'enums'>, e: EnumType): { tableId: string; table: string; column: Column }[] {
  const k = enumKey(e.name);
  return schema.tables.flatMap((t) =>
    t.columns.filter((c) => !/[()]/.test(c.type) && c.type.trim() && enumKey(c.type) === k).map((column) => ({ tableId: t.id, table: t.name, column })),
  );
}

/** ENUM을 쓰는 컬럼을 이 DB에서 실제로 만들 타입으로 바꾼 컬럼 (ENUM을 안 쓰면 그대로) */
export function resolveEnumColumn(column: Column, enums: EnumType[] | undefined, dialect: DialectId | string): Column {
  const e = enumOfType(enums, column.type);
  if (!e) return column;
  switch (dialect) {
    case 'postgresql':
      return { ...column, type: pgEnumTypeName(e.name), length: '' };
    case 'mysql':
    case 'mariadb':
      return { ...column, type: 'ENUM', length: enumValueList(e.values) };
    default: {
      // ENUM이 없는 DB: 가장 긴 값이 들어가는 VARCHAR
      const longest = Math.max(1, ...e.values.map((v) => v.length));
      return { ...column, type: 'VARCHAR', length: String(longest) };
    }
  }
}

/** 스키마의 ENUM 컬럼을 이 DB의 타입으로 펼친 복사본 (ENUM 목록은 그대로 둔다) */
export function resolveEnumColumns(schema: Schema, dialect: DialectId | string): Schema {
  if (!schema.enums?.length) return schema;
  return { ...schema, tables: schema.tables.map((t) => ({ ...t, columns: t.columns.map((c) => resolveEnumColumn(c, schema.enums, dialect)) })) };
}

/** 이 DB에 ENUM 타입 객체가 있는지 (CREATE TYPE으로 따로 만드는지) */
export const hasEnumObjects = (dialect: DialectId | string) => dialect === 'postgresql';

/**
 * 값 목록 변경이 "추가만"인지: 원래 값이 모두 같은 순서로 남아 있으면 추가할 값과 위치를 돌려준다.
 * (PostgreSQL은 값 추가만 ALTER TYPE으로 되고, 빼거나 순서를 바꾸면 타입을 다시 만들어야 한다)
 */
export function enumAdditions(before: string[], after: string[]): { value: string; before?: string; after?: string }[] | null {
  const kept = after.filter((v) => before.includes(v));
  if (kept.length !== before.length || kept.some((v, i) => v !== before[i])) return null;
  const out: { value: string; before?: string; after?: string }[] = [];
  after.forEach((v, i) => {
    if (before.includes(v)) return;
    // 바로 뒤의 기존 값 앞에, 없으면 바로 앞 값 뒤에 넣는다
    const next = after.slice(i + 1).find((x) => before.includes(x) || out.some((o) => o.value === x));
    const prev = after[i - 1];
    out.push(next && before.includes(next) ? { value: v, before: next } : prev ? { value: v, after: prev } : { value: v });
  });
  return out;
}

export function sameEnumValues(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** 입력한 타입 이름 정리: 따옴표로 감싼 사용자 타입("BillingStatus")은 대소문자를 그대로, 나머지는 대문자로 */
export function typeName(raw: string): string {
  const t = raw.trim();
  return t.includes('"') ? t : t.toUpperCase();
}

/** 타입 칸 값: ENUM 이름이면 ENUM에 적힌 이름 그대로 (order_status), 아니면 typeName */
export function canonicalType(schema: Pick<Schema, 'enums'>, raw: string): string {
  return enumOfType(schema.enums, raw)?.name ?? typeName(raw);
}

// ── 편집 (화면·AI 명령 공통) ──────────────────────────────

/** 기본 타입 이름은 ENUM 이름으로 쓸 수 없다 (컬럼 타입과 헷갈림) */
const BUILTIN_TYPES = new Set([
  'ENUM', 'SET', 'VARCHAR', 'VARCHAR2', 'NVARCHAR', 'CHAR', 'NCHAR', 'TEXT', 'CLOB', 'INT', 'INTEGER', 'BIGINT', 'SMALLINT', 'TINYINT', 'MEDIUMINT',
  'DATE', 'DATETIME', 'DATETIME2', 'TIMESTAMP', 'TIMESTAMPTZ', 'TIME', 'BOOLEAN', 'BOOL', 'BIT', 'DECIMAL', 'NUMERIC', 'NUMBER', 'FLOAT', 'DOUBLE',
  'REAL', 'MONEY', 'JSON', 'JSONB', 'UUID', 'BLOB', 'BYTEA', 'BINARY', 'VARBINARY', 'SERIAL', 'BIGSERIAL', 'XML',
]);

function checkEnumInput(schema: Schema, name: string, values: string[], exceptId?: string): void {
  if (!name.trim()) throw new Error('타입 이름을 입력하세요');
  if (BUILTIN_TYPES.has(name.trim().replace(/"/g, '').toUpperCase())) throw new Error(`"${name}"은(는) 기본 타입 이름이라 ENUM 이름으로 쓸 수 없습니다`);
  if (/[()'\s]/.test(name.trim())) throw new Error(`타입 이름 "${name}"에는 괄호·따옴표·공백을 쓸 수 없습니다`);
  const dup = (schema.enums ?? []).find((e) => e.id !== exceptId && enumKey(e.name) === enumKey(name));
  if (dup) throw new Error(`타입 "${dup.name}"이(가) 이미 있습니다`);
  if (!values.length) throw new Error(`타입 ${name}: 값을 하나 이상 넣으세요`);
}

/** ENUM 추가 */
export function addEnumType(schema: Schema, input: { name: string; values: string[]; comment?: string }): EnumType {
  const values = cleanEnumValues(input.values);
  checkEnumInput(schema, input.name, values);
  const e = createEnum({ name: input.name.trim(), values, ...(input.comment?.trim() ? { comment: input.comment.trim() } : {}) });
  schema.enums = [...(schema.enums ?? []), e];
  return e;
}

/** ENUM 고치기. 이름을 바꾸면 그 타입을 쓰는 컬럼의 타입도 함께 바꾼다 */
export function updateEnumType(schema: Schema, id: string, patch: { name?: string; values?: string[]; comment?: string }): EnumType {
  const e = (schema.enums ?? []).find((x) => x.id === id);
  if (!e) throw new Error('타입을 찾을 수 없습니다');
  const name = patch.name?.trim() ?? e.name;
  const values = patch.values ? cleanEnumValues(patch.values) : e.values;
  checkEnumInput(schema, name, values, id);
  if (name !== e.name) for (const u of enumUsages(schema, e)) u.column.type = name;
  e.name = name;
  e.values = values;
  if (patch.comment !== undefined) {
    if (patch.comment.trim()) e.comment = patch.comment.trim();
    else delete e.comment;
  }
  return e;
}

/** ENUM 지우기. 그 타입을 쓰는 컬럼은 VARCHAR(가장 긴 값)로 바꾼다. 바꾼 컬럼 수 */
export function removeEnumType(schema: Schema, id: string): number {
  const e = (schema.enums ?? []).find((x) => x.id === id);
  if (!e) return 0;
  const usages = enumUsages(schema, e);
  const longest = Math.max(1, ...e.values.map((v) => v.length));
  for (const u of usages) {
    u.column.type = 'VARCHAR';
    u.column.length = String(Math.max(longest, 20));
  }
  schema.enums = (schema.enums ?? []).filter((x) => x.id !== id);
  return usages.length;
}

/** 이름(대소문자·따옴표 무시)으로 ENUM 찾기 */
export function requireEnum(schema: Pick<Schema, 'enums'>, name: string): EnumType {
  const e = enumOfType(schema.enums, name);
  if (!e) throw new Error(`타입 "${name}"이(가) 없습니다. 있는 타입: ${(schema.enums ?? []).map((x) => x.name).join(', ') || '(없음)'}`);
  return e;
}
