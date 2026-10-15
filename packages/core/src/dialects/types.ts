import type { Column, Index, ReferentialAction, Relation, Schema, Table } from '../model';
import type { DialectFeatures } from '../features';

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
  /** SQL 붙여넣기(DDL 가져오기)에서 쓰는 문법. 없으면 이 DB의 DDL 가져오기는 지원하지 않는다 */
  ddlGrammar?: DdlGrammar;

  quote(name: string): string;
  /** 비교용 타입 문자열 (예: VARCHAR(100)). 같은 의미면 같은 문자열이 나와야 한다. */
  renderType(column: Column): string;
  /**
   * 이 이름을 SQL에 쓰면 DB가 실제로 저장하는 이름 (비교용). 없으면 쓴 그대로.
   * 예) Oracle은 따옴표 없이 쓴 member를 MEMBER로 저장한다 → ERD member와 DB MEMBER는 같은 이름 (이름을 바꾸지 않는다)
   */
  storedName?(name: string): string;
  /** 비교용 기본값. 의미가 같으면 같은 문자열이 나와야 한다. */
  normalizeDefault(value: string | null): string | null;
  /** 비교용 참조 동작. 의미가 같으면 같은 값 (MySQL은 RESTRICT와 NO ACTION이 같다) */
  normalizeAction(action: ReferentialAction): ReferentialAction;
  /**
   * 이 DB가 쓰는 기능 모듈 (features/). 넣지 않은 기능은 이 DB에 없는 기능 — 화면·명령·SQL·설계 검사 어디에서도 쓰지 않는다.
   * 공통 코드는 DB 이름을 묻지 않고 이 모듈이 있는지만 본다.
   */
  features: DialectFeatures;
  /** 기능이 아니라 DB의 성질 (설계 검사·SQL 순서에 쓴다) */
  traits: DialectTraits;
  /** DB 반영 전 안전 검사(읽기 전용 SELECT COUNT)에 쓰는 이 DB의 SQL 조각 */
  safety: DialectSafetySql;
  /** 컬럼 타입 검사에 쓰는 이 DB의 타입 정보 */
  types: TypeProfile;
  /** DB 연결 입력 안내 */
  connection: ConnectionInfo;

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
  /** CREATE TABLE 안에 함께 만드는 인덱스 id (MySQL: 기본키가 아닌 AUTO_INCREMENT 컬럼은 테이블을 만들 때 키가 있어야 한다). 이 인덱스는 따로 만들지 않는다 */
  inlineIndexIds?(table: Table): string[];
  /** keepForFk: 이 인덱스에 기대는 FK가 있으면 같은 문장에서 FK용 인덱스를 만든다 (fkNeedsIndex인 DB) */
  dropIndex(table: Table, index: Index, keepForFk?: { name: string; columnIds: string[] }[]): string[];

  addForeignKey(schema: Schema, relation: Relation): string[];
  dropForeignKey(schema: Schema, relation: Relation): string[];
}

/** 문자·바이너리 타입 최대 길이. useMax: 넘으면 MAX로 바꾸게 한다 (SQL Server). soft: DB 설정에 따라 넘을 수 있는 기본 한도 (Oracle) */
export interface StringLimit {
  max: number;
  soft?: number;
  useMax?: boolean;
}

/**
 * 이 DB의 타입 정보 (컬럼 타입 검사가 쓴다 — typeRules.ts). 검사 규칙은 공통이고, 규칙이 볼 값은 DB가 이 표로 준다.
 * 없는 칸은 그 DB에 해당 규칙이 없다는 뜻이다.
 */
export interface TypeProfile {
  /** 아는 타입 이름 (첫 단어). 여기 없으면 오타이거나 다른 DB 타입일 수 있어 경고 */
  known: Set<string>;
  /** 따옴표로 감싼 이름은 직접 만든 타입으로 본다 (PostgreSQL CREATE TYPE·DOMAIN) */
  quotedUserTypes?: boolean;
  /** 자동 증가 */
  autoIncrement: {
    /** 화면에 보일 이름 (AUTO_INCREMENT, IDENTITY) */
    label: string;
    /** 쓸 수 있는 정수 타입 */
    integers: Set<string>;
    /** 정수 말고도 되는 타입 (예: SQL Server DECIMAL(p,0), Oracle NUMBER) */
    also?: (base: string, scale: number) => boolean;
    /** FLOAT·DOUBLE에도 되지만 곧 없어질 기능 (MySQL) */
    floatDeprecated?: boolean;
    /** 자동 증가 컬럼에 기본값: error(실패) / ignored(쓰지 않음) */
    defaultValue: 'error' | 'ignored';
    /** 한 테이블에 자동 증가 컬럼은 하나만 */
    single?: boolean;
    /** 자동 증가 컬럼은 기본키 첫 컬럼이거나 인덱스 첫 컬럼이어야 함 (MySQL) */
    mustBeKey?: boolean;
  };
  /** 소수 초 자릿수(0~6)를 괄호에 쓰는 타입. over: 넘으면 실패(error) / 6으로 줄여 만듦(clamp) */
  fraction?: { types: Set<string>; over: 'error' | 'clamp' };
  /** 괄호(길이)를 쓰면 문법 오류인 타입 */
  noLength?: Set<string>;
  /** 길이를 꼭 써야 하는 타입 */
  lengthRequired?: Set<string>;
  /** SQL을 만들 때 길이를 빼는 타입이 있으면 알린다 (renderType이 길이를 지우는 DB) */
  reportsIgnoredLength?: boolean;
  /** 문자·바이너리 타입별 최대 길이 */
  strings: Record<string, StringLimit>;
  /** 길이 뒤에 붙는 단위 (Oracle: VARCHAR2(100 CHAR)) */
  lengthSuffix?: RegExp;
  /** 너무 긴 VARCHAR는 TEXT로 바꾸게 한다 */
  tooLongToText?: boolean;
  /** 정수 타입 괄호 숫자(표시 폭)는 0~255 */
  integerDisplayWidth?: boolean;
  /** DECIMAL 계열 최대 자릿수(p)·소수 자릿수(s) */
  decimal?: { types: Set<string>; p: number; s: number; sWithinP: boolean; minS?: number };
  /** ON UPDATE 시각 함수 자릿수가 컬럼 자릿수와 같아야 한다 */
  onUpdatePrecisionStrict?: boolean;
  /** 기본값 CURRENT_TIMESTAMP는 이 타입에만, 자릿수도 컬럼과 같아야 한다 */
  defaultTimeStrict?: { types: Set<string> };
  /** 값 그대로의 기본값을 둘 수 없는 타입 (괄호 식만 됨) */
  lobNoLiteralDefault?: RegExp;
  /** BOOLEAN 기본값은 TRUE/FALSE로 쓴다 (0/1은 실패) */
  booleanLiteral?: boolean;
  /** 한 행 최대 바이트 (넘으면 실패). utf8mb4 등 계산은 rowBytes가 한다 */
  rowSize?: { max: number; bytes(columns: Column[]): { bytes: number; widest?: Column } };
}

/** SQL 붙여넣기(DDL 읽기) 문법 */
export interface DdlGrammar {
  /** 문법 갈래 (다른 DB의 DDL인지 알아볼 때. ddlGrammarOf가 돌려주는 값과 같다) */
  family: 'mysql' | 'postgresql';
  /** '...' 안의 \ 를 이스케이프로 본다 (MySQL) */
  backslashEscapes: boolean;
  /** 외래키용으로 DB가 자동으로 만든 인덱스(이름이 FK와 같음)는 ERD에 그리지 않는다 (MySQL) */
  hidesFkIndexes: boolean;
  /** 기본키 제약조건 이름을 기억한다 (PostgreSQL) */
  keepsPrimaryKeyName: boolean;
  /** 따옴표로 감싼 타입 이름은 대소문자를 지킨다 (PostgreSQL 사용자 타입) */
  quotedTypeNames: boolean;
}

export interface ConnectionInfo {
  /** 기본 포트 */
  port: number;
  /** 데이터베이스 칸 이름 (MySQL: 스키마(DB), Oracle: 서비스 이름) */
  databaseLabel: string;
  databasePlaceholder: string;
  /** 스키마 입력칸 안내 (없으면 칸을 숨김) */
  schemaPlaceholder?: string;
  /** DDL을 트랜잭션으로 묶어 실패 시 모두 되돌리는지 */
  transactional: boolean;
}

export interface DialectSafetySql {
  /** inner("FROM ... WHERE ..." 또는 GROUP BY ... HAVING 포함)에 맞는 행을 n개까지만 세는 SQL. 결과 컬럼 이름은 n */
  countUpTo(inner: string, n: number): string;
  /** 글자 수 함수 */
  lengthFn: string;
  /** 이 컬럼 값이 숫자(정수)로 바꿀 수 없는 행 조건 */
  notNumeric(col: string, integer: boolean): string;
}

export interface DialectTraits {
  /** 외래키 컬럼에 DB가 인덱스를 자동으로 만든다 (설계 검사의 'FK에 인덱스 없음'을 보지 않는다) */
  fkAutoIndex?: boolean;
  /** 외래키에 인덱스가 꼭 있어야 해서, FK가 쓰는 인덱스를 그냥 지울 수 없다 */
  fkNeedsIndex?: boolean;
  /** JSON 컬럼에 일반 인덱스를 만들 수 없다 */
  noJsonColumnIndex?: boolean;
  /** 길이 없는 VARCHAR는 타입 검사가 '실패'로 알린다 (설계 검사의 '문자 길이 없음'은 건너뜀) */
  varcharLengthIsTypeError?: boolean;
}
