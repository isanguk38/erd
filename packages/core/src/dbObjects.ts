// DB 객체: 뷰·함수·프로시저·트리거·이벤트·패키지 등 테이블이 아닌 것.
// 화면·AI는 DB가 쓰는 CREATE 문(DDL) 그대로 보고 고친다. ERD 그림에는 그리지 않는다.
// DB에서 가져오면 DB가 돌려준 DDL이 들어오고, 고쳐서 DB로 내보내면 바뀐 것만 지웠다 다시 만든다 (DB별 방법은 dialects의 objects 모듈).
// 어떤 종류를 다룰 수 있는지는 DB마다 다르다 (예: 이벤트는 MySQL·MariaDB, 패키지는 Oracle).

import { newId, type Schema } from './model';

export type DbObjectKind = 'view' | 'materializedView' | 'function' | 'procedure' | 'trigger' | 'event' | 'package' | 'packageBody';

export interface DbObject {
  id: string;
  kind: DbObjectKind;
  /** 이름 (스키마 이름·따옴표 없이) */
  name: string;
  /** 트리거가 걸린 테이블 */
  table?: string;
  /** 전체 CREATE 문 */
  definition: string;
  /** 설명 (ERD에만 저장) */
  comment?: string;
}

export const DB_OBJECT_LABEL: Record<DbObjectKind, string> = {
  view: '뷰',
  materializedView: '구체화 뷰',
  function: '함수',
  procedure: '프로시저',
  trigger: '트리거',
  event: '이벤트',
  package: '패키지',
  packageBody: '패키지 본문',
};

/** 만드는 순서 (함수·프로시저 → 뷰 → 트리거·이벤트). 지울 때는 거꾸로 */
export const DB_OBJECT_ORDER: DbObjectKind[] = ['package', 'packageBody', 'function', 'procedure', 'view', 'materializedView', 'trigger', 'event'];

/** 같은 객체인지 보는 키 (대소문자 무시, 트리거는 테이블까지) */
export const objectKey = (o: Pick<DbObject, 'kind' | 'name' | 'table'>) =>
  `${o.kind}:${o.name.trim().toLowerCase()}${o.kind === 'trigger' && o.table ? `@${o.table.trim().toLowerCase()}` : ''}`;

/** DB 계정(DEFINER)·끝의 ; / 처럼 환경마다 다르거나 의미 없는 것을 빼고, 공백을 맞춘다 (같은 정의인지 비교용) */
export function normalizeDefinition(sql: string): string {
  return stripDefiner(sql)
    .replace(/\r\n?/g, '\n')
    .replace(/[\s;/]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** MySQL·MariaDB의 DEFINER=`user`@`host` (다른 DB·계정에서 실패하므로 저장하지 않는다) */
export function stripDefiner(sql: string): string {
  return sql.replace(/\s+DEFINER\s*=\s*(`[^`]*`|'[^']*'|"[^"]*"|[\w.%-]+)\s*@\s*(`[^`]*`|'[^']*'|"[^"]*"|[\w.%-]+)/i, '');
}

export const sameDefinition = (a: string, b: string) => normalizeDefinition(a) === normalizeDefinition(b);

const IDENT = String.raw`(?:"[^"]+"|\`[^\`]+\`|\[[^\]]+\]|[\w$#]+)`;
const QUALIFIED = String.raw`${IDENT}(?:\s*\.\s*${IDENT})*`;
const unquote = (name: string) => name.trim().replace(/^["`[]|["`\]]$/g, '');
/** schema.name → name */
const lastPart = (qualified: string) => unquote(qualified.split(/\s*\.\s*(?=(?:[^"`[\]]|"[^"]*"|`[^`]*`|\[[^\]]*\])*$)/).pop() ?? qualified);

const HEADER = new RegExp(
  String.raw`^\s*CREATE\s+(?:OR\s+(?:REPLACE|ALTER)\s+)?(?:(?:ALGORITHM\s*=\s*\w+|SQL\s+SECURITY\s+\w+|DEFINER\s*=\s*\S+|EDITIONABLE|NONEDITIONABLE|FORCE|NOFORCE|AGGREGATE|DEFINITION\s+ONLY|CONSTRAINT)\s+)*` +
    String.raw`(MATERIALIZED\s+VIEW|VIEW|FUNCTION|PROCEDURE|PROC|TRIGGER|EVENT|PACKAGE\s+BODY|PACKAGE)\s+(?:IF\s+NOT\s+EXISTS\s+)?(${QUALIFIED})`,
  'i',
);

/** CREATE 문에서 종류·이름·(트리거) 테이블을 읽는다. CREATE 문이 아니면 null */
export function parseObjectDdl(sql: string): Pick<DbObject, 'kind' | 'name' | 'table'> | null {
  const text = sql.replace(/^\s*(--[^\n]*\n|\/\*[\s\S]*?\*\/)*/g, '');
  const m = HEADER.exec(text);
  if (!m) return null;
  const word = m[1].toUpperCase().replace(/\s+/g, ' ');
  const kind: DbObjectKind =
    word === 'MATERIALIZED VIEW' ? 'materializedView' : word === 'VIEW' ? 'view' : word === 'FUNCTION' ? 'function' : word === 'PROCEDURE' || word === 'PROC' ? 'procedure'
      : word === 'TRIGGER' ? 'trigger' : word === 'EVENT' ? 'event' : word === 'PACKAGE BODY' ? 'packageBody' : 'package';
  const name = lastPart(m[2]);
  if (kind !== 'trigger') return { kind, name };
  const on = new RegExp(String.raw`\bON\s+(${QUALIFIED})`, 'i').exec(text.slice(m.index + m[0].length));
  return { kind, name, ...(on ? { table: lastPart(on[1]) } : {}) };
}

/** 같은 종류·이름의 객체 (트리거는 테이블까지) */
export function findObject(schema: Schema, ref: Pick<DbObject, 'kind' | 'name'> & { table?: string }): DbObject | undefined {
  const list = schema.objects ?? [];
  const exact = list.find((o) => objectKey(o) === objectKey(ref));
  if (exact || ref.kind !== 'trigger' || ref.table) return exact;
  return list.find((o) => o.kind === 'trigger' && o.name.toLowerCase() === ref.name.trim().toLowerCase());
}

/** 이름으로 찾기 (종류를 모를 때). 여러 개면 오류 */
export function findObjectByName(schema: Schema, name: string, kind?: DbObjectKind): DbObject {
  const list = (schema.objects ?? []).filter((o) => o.name.toLowerCase() === name.trim().toLowerCase() && (!kind || o.kind === kind));
  if (!list.length) throw new Error(`DB 객체 ${name}이(가) 없습니다. 있는 것: ${(schema.objects ?? []).map((o) => `${DB_OBJECT_LABEL[o.kind]} ${o.name}`).join(', ') || '(없음)'}`);
  if (list.length > 1) throw new Error(`${name}이(가) 여러 개입니다 (${list.map((o) => DB_OBJECT_LABEL[o.kind]).join(', ')}) — 종류(kind)를 주세요`);
  return list[0];
}

/** DDL로 객체를 만든다 (종류·이름은 DDL에서 읽는다). kinds: 이 DB에서 다룰 수 있는 종류 */
export function addObject(schema: Schema, definition: string, kinds: DbObjectKind[]): DbObject {
  const header = parseObjectDdl(definition);
  if (!header) throw new Error('CREATE 문이 아닙니다. CREATE VIEW / FUNCTION / PROCEDURE / TRIGGER … 로 시작하는 DDL을 넣으세요');
  if (!kinds.includes(header.kind)) throw new Error(`이 DB에서는 ${DB_OBJECT_LABEL[header.kind]}을(를) 다룰 수 없습니다 (다룰 수 있는 것: ${kinds.map((k) => DB_OBJECT_LABEL[k]).join(', ')})`);
  if (findObject(schema, header)) throw new Error(`${DB_OBJECT_LABEL[header.kind]} ${header.name}이(가) 이미 있습니다`);
  const object: DbObject = { id: newId('obj'), ...header, definition: stripDefiner(definition).trim() };
  schema.objects = [...(schema.objects ?? []), object];
  return object;
}

/** 객체의 DDL을 바꾼다. 이름·종류를 바꾸는 DDL이면 그 이름으로 (같은 이름이 있으면 오류) */
export function updateObject(schema: Schema, id: string, patch: { definition?: string; comment?: string }, kinds?: DbObjectKind[]): DbObject {
  const object = (schema.objects ?? []).find((o) => o.id === id);
  if (!object) throw new Error('DB 객체를 찾을 수 없습니다');
  if (patch.definition !== undefined) {
    const header = parseObjectDdl(patch.definition);
    if (!header) throw new Error('CREATE 문이 아닙니다. CREATE VIEW / FUNCTION / PROCEDURE / TRIGGER … 로 시작하는 DDL을 넣으세요');
    if (kinds && !kinds.includes(header.kind)) throw new Error(`이 DB에서는 ${DB_OBJECT_LABEL[header.kind]}을(를) 다룰 수 없습니다`);
    const other = findObject(schema, header);
    if (other && other.id !== id) throw new Error(`${DB_OBJECT_LABEL[header.kind]} ${header.name}이(가) 이미 있습니다`);
    Object.assign(object, header, { definition: stripDefiner(patch.definition).trim() });
    if (header.kind !== 'trigger') delete object.table;
  }
  if (patch.comment !== undefined) object.comment = patch.comment.trim() || undefined;
  return object;
}

export function removeObject(schema: Schema, id: string): void {
  schema.objects = (schema.objects ?? []).filter((o) => o.id !== id);
}

/**
 * DB로 내보낸 뒤: 이번에 만들거나 바꾼 객체의 정의를 DB가 돌려준 모양으로 맞춘다.
 * DB는 받은 DDL을 자기 형식으로 다시 쓰므로(뷰의 SELECT 정리, 따옴표 등) 그대로 두면 다음 비교에서 "ERD에서 바뀜"으로 보인다.
 * 돌려주는 것: ERD에서 바꿀 객체 id와 DB의 정의
 */
export function adoptDbObjectDefinitions(erd: Schema, db: Schema, pushedKeys: Iterable<string>): { id: string; definition: string }[] {
  const keys = new Set(pushedKeys);
  const fromDb = new Map((db.objects ?? []).map((o) => [objectKey(o), o]));
  return (erd.objects ?? []).flatMap((o) => {
    const k = objectKey(o);
    const d = fromDb.get(k);
    return keys.has(k) && d && d.definition !== o.definition ? [{ id: o.id, definition: d.definition }] : [];
  });
}

/** 실행한 변경 중 DB 객체를 만들거나 바꾼 것의 키 (adoptDbObjectDefinitions에 넘긴다) */
export function pushedObjectKeys(changes: readonly import('./diff').Change[]): string[] {
  return changes.flatMap((c) => (c.kind === 'createObject' ? [objectKey(c.object)] : c.kind === 'alterObject' ? [objectKey(c.after)] : []));
}
