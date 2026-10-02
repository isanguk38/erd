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
  comment: string;
}

export interface Index {
  id: string;
  name: string;
  columnIds: string[];
  unique: boolean;
  /** DB에서 읽은 UNIQUE 제약조건이면 true (PostgreSQL은 제약조건과 인덱스를 지우는 문법이 다르다) */
  isConstraint?: boolean;
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

/**
 * 영역: 관련 테이블을 색깔 상자로 묶는다 (화면 정리용, SQL에는 영향 없음).
 * 상자를 옮기면 안의 테이블도 함께 옮겨지고, 접으면 안의 테이블을 숨긴다.
 */
export interface Area {
  id: string;
  name: string;
  color: string;
  position: { x: number; y: number };
  size: { width: number; height: number };
  /** 이 영역에 속한 테이블 */
  tableIds: string[];
  collapsed?: boolean;
}

export interface Schema {
  tables: Table[];
  relations: Relation[];
  /** 영역. undefined면 "영역은 건드리지 않음"으로 다룬다 (DB 가져오기·버전 복원 등이 영역을 지우지 않게) */
  areas?: Area[];
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
  const cols = index.columnIds.map((id) => findColumn(table, id)?.name ?? id);
  return `${index.unique ? 'ux' : 'ix'}_${table.name}_${cols.join('_')}`;
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
