import type { CheckConstraint, Column, Index, ReferentialAction, Relation, Schema, Table } from '../model';

/** 새 DB를 추가하려면 이 목록에 id를 넣고 Dialect를 구현해 registry에 등록한다. */
export type DialectId = 'mysql' | 'mariadb' | 'postgresql' | 'oracle' | 'mssql';

export type ColumnField = 'name' | 'type' | 'nullable' | 'defaultValue' | 'onUpdate' | 'generated' | 'autoIncrement' | 'comment';

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
  /** 외래키에 인덱스가 꼭 있어야 해서, FK가 쓰는 인덱스를 그냥 지울 수 없는 DB (MySQL·MariaDB) */
  fkNeedsIndex?: boolean;
  /** 지원하는 인덱스 기능: 식 인덱스, 부분 인덱스(WHERE), 인덱스 방식(gin 등). 없는 기능은 SQL에서 빼거나 주의를 단다 */
  indexSupport?: { expression?: boolean; where?: boolean; /** 쓸 수 있는 인덱스 방식 (btree 외) */ methods?: string[] };

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
  /** keepForFk: 이 인덱스에 기대는 FK가 있으면 같은 문장에서 FK용 인덱스를 만든다 (fkNeedsIndex인 DB) */
  dropIndex(table: Table, index: Index, keepForFk?: { name: string; columnIds: string[] }[]): string[];

  addForeignKey(schema: Schema, relation: Relation): string[];
  dropForeignKey(schema: Schema, relation: Relation): string[];
  /** CHECK 제약 추가/삭제 (없으면 ALTER TABLE ... ADD/DROP CONSTRAINT) */
  addCheck?(table: Table, check: CheckConstraint): string[];
  dropCheck?(table: Table, check: CheckConstraint): string[];
  /** 계산 컬럼에서 쓸 수 있는 방식: virtual(값을 저장하지 않음)·stored(저장) */
  generatedSupport?: { virtual?: boolean; stored?: boolean; /** false면 계산 컬럼의 타입을 DB가 정한다 (SQL Server) → 타입은 비교하지 않는다 */ typed?: boolean };
}
