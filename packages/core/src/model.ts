// ERD 전체가 공유하는 스키마 모델.
// 모든 요소는 고유 id를 가진다. 이름이 바뀌어도 id가 유지되므로 비교 시 RENAME을 정확히 찾을 수 있다.

export type Cardinality = '1:1' | '1:N';
export type ReferentialAction = 'NO ACTION' | 'RESTRICT' | 'CASCADE' | 'SET NULL' | 'SET DEFAULT';

export interface Column {
  id: string;
  /** 물리명 (예: member_id) */
  name: string;
  /** 논리명 (예: 회원번호) */
  logicalName: string;
  /** 대문자 타입 이름 (예: VARCHAR, BIGINT). DB별 변환은 dialect가 맡는다. */
  type: string;
  /** 길이/정밀도 (예: "100", "10,2"). 없으면 빈 문자열 */
  length: string;
  nullable: boolean;
  primaryKey: boolean;
  unique: boolean;
  autoIncrement: boolean;
  /** SQL 그대로의 기본값 (예: "0", "'Y'", "CURRENT_TIMESTAMP"). 없으면 null */
  defaultValue: string | null;
  /** MySQL·MariaDB: 행이 바뀔 때 자동으로 넣는 값 (ON UPDATE CURRENT_TIMESTAMP). 없으면 생략 */
  onUpdate?: string;
  /**
   * 계산 컬럼: 다른 컬럼으로 값을 계산한다 (GENERATED ALWAYS AS (식)). stored면 계산한 값을 저장한다.
   * 예) { expression: 'qty * price', stored: false }
   */
  generated?: { expression: string; stored?: boolean };
  comment: string;
}

export interface Index {
  id: string;
  name: string;
  columnIds: string[];
  unique: boolean;
  /** DB에서 읽은 UNIQUE 제약조건이면 true (PostgreSQL은 제약조건과 인덱스를 지우는 문법이 다르다) */
  isConstraint?: boolean;
  /**
   * 식(함수) 인덱스: 컬럼 대신 이 식으로 인덱스를 만든다. ON 테이블 ( ... ) 괄호 안에 들어갈 원문 그대로.
   * 예) PostgreSQL: lower(email) / (metadata ->> 'sitecd') / to_tsvector('simple', body)
   *     MySQL 8: (lower(`email`)) — 식마다 괄호를 한 번 더 감싼다
   * 있으면 columnIds는 비워 둔다.
   */
  expression?: string;
  /** 인덱스 방식 (PostgreSQL: gin, gist, brin, hash). 비우면 기본(btree) */
  method?: string;
  /** 부분 인덱스 조건 (WHERE 뒤에 오는 식) */
  where?: string;
}

export interface Table {
  id: string;
  name: string;
  logicalName: string;
  comment: string;
  columns: Column[];
  indexes: Index[];
  position: { x: number; y: number };
  color?: string;
  /** DB에서 읽어온 PK 제약조건 이름 (PostgreSQL). 없으면 기본 이름을 쓴다. */
  primaryKeyName?: string;
  /** CHECK 제약 (예: point >= 0) */
  checks?: CheckConstraint[];
}

export interface CheckConstraint {
  id: string;
  /** 비우면 ck_테이블_번호 */
  name: string;
  /** CHECK ( ... ) 괄호 안의 식 */
  expression: string;
}

export function createCheck(partial: Partial<CheckConstraint> = {}): CheckConstraint {
  return { id: newId('chk'), name: '', expression: '', ...partial };
}

/** CHECK 제약 이름 (비어 있으면 ck_테이블_순번) */
export function checkName(table: Table, check: CheckConstraint): string {
  if (check.name.trim()) return check.name.trim();
  const n = (table.checks ?? []).findIndex((c) => c.id === check.id) + 1;
  return `ck_${table.name}_${n || 1}`.slice(0, 60);
}

/** 외래키. 자식(from) 테이블의 컬럼이 부모(to) 테이블의 컬럼을 참조한다. */
export interface Relation {
  id: string;
  /** 제약조건 이름. 비어 있으면 자동으로 만든다. */
  name: string;
  fromTableId: string;
  fromColumnIds: string[];
  toTableId: string;
  toColumnIds: string[];
  cardinality: Cardinality;
  onDelete: ReferentialAction;
  onUpdate: ReferentialAction;
}

export interface Schema {
  tables: Table[];
  relations: Relation[];
}

export function emptySchema(): Schema {
  return { tables: [], relations: [] };
}

let counter = 0;
export function newId(prefix = 'id'): string {
  counter = (counter + 1) % 1_000_000;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${rand}`;
}

export function createColumn(partial: Partial<Column> = {}): Column {
  return {
    id: newId('col'),
    name: 'column',
    logicalName: '',
    type: 'VARCHAR',
    length: '255',
    nullable: true,
    primaryKey: false,
    unique: false,
    autoIncrement: false,
    defaultValue: null,
    comment: '',
    ...partial,
  };
}

export function createTable(partial: Partial<Table> = {}): Table {
  return {
    id: newId('tbl'),
    name: 'new_table',
    logicalName: '',
    comment: '',
    columns: [],
    indexes: [],
    position: { x: 0, y: 0 },
    ...partial,
  };
}

export function createIndex(partial: Partial<Index> = {}): Index {
  return { id: newId('idx'), name: '', columnIds: [], unique: false, ...partial };
}

export function createRelation(partial: Partial<Relation> & Pick<Relation, 'fromTableId' | 'toTableId'>): Relation {
  return {
    id: newId('rel'),
    name: '',
    fromColumnIds: [],
    toColumnIds: [],
    cardinality: '1:N',
    onDelete: 'NO ACTION',
    onUpdate: 'NO ACTION',
    ...partial,
  };
}

export function findTable(schema: Schema, id: string): Table | undefined {
  return schema.tables.find((t) => t.id === id);
}

export function findColumn(table: Table, id: string): Column | undefined {
  return table.columns.find((c) => c.id === id);
}

export function primaryKeyColumns(table: Table): Column[] {
  return table.columns.filter((c) => c.primaryKey);
}

/** 인덱스 이름이 비어 있을 때 쓰는 기본 이름 */
export function indexName(table: Table, index: Index): string {
  if (index.name) return index.name;
  if (index.expression?.trim()) {
    const words = index.expression.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
    return `${index.unique ? 'ux' : 'ix'}_${table.name}_${words.join('_')}`.slice(0, 60);
  }
  const cols = index.columnIds.map((id) => findColumn(table, id)?.name ?? id);
  return `${index.unique ? 'ux' : 'ix'}_${table.name}_${cols.join('_')}`;
}

/** 식 인덱스인지 */
export function isExpressionIndex(index: Index): boolean {
  return Boolean(index.expression?.trim());
}

/** 화면·요약에 보여 줄 인덱스 내용: 컬럼 이름들 또는 식 (방식·조건 포함) */
export function indexLabel(table: Table, index: Index): string {
  const keys = isExpressionIndex(index) ? index.expression!.trim() : index.columnIds.map((id) => findColumn(table, id)?.name ?? '?').join(', ');
  return `${index.method?.trim() ? `${index.method.trim()} ` : ''}${keys}${index.where?.trim() ? ` WHERE ${index.where.trim()}` : ''}`;
}

/** 식이 사실 컬럼 이름 나열뿐이면 그 컬럼 id들 (예: "metadata", "a, b"). 아니면 null */
export function expressionColumns(table: Table, expression: string | undefined): string[] | null {
  if (!expression?.trim()) return null;
  const ids: string[] = [];
  for (const part of expression.split(',')) {
    const m = part.trim().match(/^[`"[]?([\w$]+)[`"\]]?$/);
    const column = m && table.columns.find((c) => c.name.toLowerCase() === m[1].toLowerCase());
    if (!column) return null;
    ids.push(column.id);
  }
  return ids;
}

/** 두 식이 같은지 (공백·따옴표·대소문자·괄호·PostgreSQL 형 변환(::text) 차이는 무시) */
export function sameExpression(a: string | undefined, b: string | undefined): boolean {
  const norm = (v: string | undefined) =>
    (v ?? '')
      .toLowerCase()
      .replace(/::\s*(character varying|double precision|timestamp with(out)? time zone|[a-z_][a-z0-9_]*)(\[\])?/g, '')
      // MySQL은 문자열 앞에 문자셋을 붙여 돌려준다: _utf8mb4'A' = 'A'
      .replace(/_(utf8mb4|utf8mb3|utf8|latin1|binary|ascii)'/g, "'")
      // PostgreSQL은 BETWEEN을 풀어서 저장한다: a BETWEEN 0 AND 100 = (a >= 0) AND (a <= 100)
      .replace(/([\w."`]+)\s+between\s+(\S+)\s+and\s+(\S+)/g, '$1 >= $2 and $1 <= $3')
      .replace(/["`\s]/g, '')
      // MySQL은 JSON 줄임 문법을 풀어서 저장한다: profile->>'$.a' = json_unquote(json_extract(profile,'$.a')), -> = json_extract
      .replace(/json_unquote\(json_extract\(([\w$.]+),('[^']*')\)\)/g, '$1->>$2')
      .replace(/json_extract\(([\w$.]+),('[^']*')\)/g, '$1->$2')
      // CAST(... AS CHAR(30)) 뒤에 붙는 문자셋 표기
      .replace(/charset[a-z0-9_]+/g, '')
      .replace(/[[\]()]/g, '')
      // PostgreSQL은 IN 목록을 배열 비교로 저장한다: a IN ('X','Y') = a = ANY (ARRAY['X','Y']), NOT IN = <> ALL
      .replace(/=anyarray/g, 'in')
      .replace(/<>allarray/g, 'notin');
  return norm(a) === norm(b);
}

/** 인덱스 방식이 같은지 (비어 있으면 btree) */
export function sameIndexMethod(a: string | undefined, b: string | undefined): boolean {
  const norm = (v: string | undefined) => (v?.trim().toLowerCase() || 'btree');
  return norm(a) === norm(b);
}

/** 외래키 이름이 비어 있을 때 쓰는 기본 이름 */
export function relationName(schema: Schema, relation: Relation): string {
  if (relation.name) return relation.name;
  const from = findTable(schema, relation.fromTableId);
  const to = findTable(schema, relation.toTableId);
  return `fk_${from?.name ?? 'unknown'}_${to?.name ?? 'unknown'}`;
}

export function cloneSchema(schema: Schema): Schema {
  return structuredClone(schema);
}
