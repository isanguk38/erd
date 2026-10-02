import type { Column, Index, ReferentialAction, Relation, Schema, Table } from '../model';

/** 새 DB를 추가하려면 이 목록에 id를 넣고 Dialect를 구현해 registry에 등록한다. */
export type DialectId = 'mysql' | 'mariadb' | 'postgresql' | 'oracle' | 'mssql';

export type ColumnField = 'name' | 'type' | 'nullable' | 'defaultValue' | 'autoIncrement' | 'comment';

/**
 * DB 종류별 SQL 문법.
 * 모든 메서드는 실행할 SQL 문장 목록을 돌려준다 (세미콜론 없이).
 */
export interface Dialect {
  id: DialectId;
  label: string;
  /** 화면의 타입 자동완성 목록 */
  typeSuggestions: string[];

  quote(name: string): string;
  /** 비교용 타입 문자열 (예: VARCHAR(100)). 같은 의미면 같은 문자열이 나와야 한다. */
  renderType(column: Column): string;
  /** 비교용 기본값. 의미가 같으면 같은 문자열이 나와야 한다. */
  normalizeDefault(value: string | null): string | null;
  /** 비교용 참조 동작. 의미가 같으면 같은 값 (MySQL은 RESTRICT와 NO ACTION이 같다) */
  normalizeAction(action: ReferentialAction): ReferentialAction;
  /** 외래키 ON UPDATE를 지원하는지 (Oracle은 없음 → 비교·SQL에서 빼고 본다). 기본 true */
  supportsOnUpdate?: boolean;

  createTable(table: Table): string[];
  dropTable(table: Table): string[];
  renameTable(from: Table, to: Table): string[];
  setTableComment(table: Table): string[];

  addColumn(table: Table, column: Column, previous: Column | null): string[];
  dropColumn(table: Table, column: Column): string[];
  /** beforeTable: 바뀌기 전 테이블 (SQL Server처럼 인덱스를 잠깐 지웠다 다시 만들어야 하는 DB용) */
  alterColumn(table: Table, before: Column, after: Column, changed: ColumnField[], beforeTable?: Table): string[];
  changePrimaryKey(before: Table, after: Table): string[];

  createIndex(table: Table, index: Index): string[];
  dropIndex(table: Table, index: Index): string[];

  addForeignKey(schema: Schema, relation: Relation): string[];
  dropForeignKey(schema: Schema, relation: Relation): string[];
}
