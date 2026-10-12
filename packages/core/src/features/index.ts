// DB마다 다른 기능을 모듈로 나눈 것.
// 각 DBMS(dialects/*.ts)는 쓰는 기능 모듈만 features에 넣는다. 넣지 않은 기능은 그 DB에서 "없는 기능"이다 —
// 화면(버튼·창)·AI 명령·SQL·설계 검사 어디에서도 그 기능을 쓰지 않는다 (DB 이름으로 나누는 if 없이 모듈이 있는지만 본다).
//
// 예) ENUM: MySQL·MariaDB는 enumInColumn, PostgreSQL은 enumAsTypeObject(...), Oracle·SQL Server는 없음
//
// 모든 DB에 똑같이 있는 것(테이블·컬럼·관계·주제영역·메모 등)은 모듈로 나누지 않는다.

import type { CheckConstraint, Column, EnumType, Table } from '../model';

/** 사용자 정의 타입 (ENUM) */
export interface EnumFeature {
  /** 'type': 타입 객체를 따로 만든다 (CREATE TYPE), 'column': 컬럼마다 ENUM('..')으로 쓴다 */
  kind: 'type' | 'column';
  /** ENUM을 쓰는 컬럼을 이 DB에서 실제로 만들 타입으로 */
  resolveColumn(column: Column, enumType: EnumType): Column;
  /** 타입 객체를 만드는 DB만: 만들기·지우기·값 바꾸기 SQL (usages: 그 타입을 쓰는 컬럼) */
  create?(enumType: EnumType): string[];
  drop?(enumType: EnumType): string[];
  alter?(before: EnumType, after: EnumType, usages: { table: string; column: Column }[]): string[];
  /** 화면 안내 (타입 창 위에 보인다) */
  help: string;
}

/** CHECK 제약 */
export interface CheckFeature {
  add(table: Table, check: CheckConstraint): string[];
  drop(table: Table, check: CheckConstraint): string[];
}

/** 식(함수) 인덱스 */
export interface ExpressionIndexFeature {
  /** "+ 식 인덱스"를 누르면 넣어 둘 예시 (첫 컬럼 이름으로) */
  example(column: string): string;
  /** 식 칸 아래 안내 */
  hint: string;
  /** 이 DB에서 실패할 다른 DB 문법이 식에 있으면 안내 */
  warn?(expression: string): string | undefined;
}

/** 부분 인덱스 (CREATE INDEX ... WHERE 조건) */
export interface PartialIndexFeature {
  /** 조건 칸 예시 */
  placeholder: string;
}

/** 인덱스 방식 (PostgreSQL: gin·gist…, MySQL: FULLTEXT·SPATIAL) */
export interface IndexMethodFeature {
  methods: string[];
  /** 고르는 칸에 보일 이름 */
  label(method: string): string;
}

/** 계산 컬럼 (GENERATED ALWAYS AS) */
export interface GeneratedFeature {
  /** 값을 저장하지 않는 방식(VIRTUAL)이 있는지 */
  virtual?: boolean;
  /** 값을 저장하는 방식(STORED·PERSISTED)이 있는지 */
  stored?: boolean;
  /** false면 계산 컬럼의 타입을 DB가 정한다 (SQL Server) → 타입은 비교하지 않는다 */
  typed?: boolean;
}

/** 행이 바뀔 때 시각을 넣는 ON UPDATE CURRENT_TIMESTAMP (MySQL·MariaDB) */
export interface OnUpdateTimestampFeature {
  /** 이 타입들에만 쓸 수 있다 */
  types: RegExp;
}

/** 외래키의 ON UPDATE 동작 (Oracle에는 없다) */
export interface FkOnUpdateFeature {
  actions: ('NO ACTION' | 'RESTRICT' | 'CASCADE' | 'SET NULL' | 'SET DEFAULT')[];
}

export interface DialectFeatures {
  enum?: EnumFeature;
  check?: CheckFeature;
  expressionIndex?: ExpressionIndexFeature;
  partialIndex?: PartialIndexFeature;
  indexMethods?: IndexMethodFeature;
  generated?: GeneratedFeature;
  onUpdateTimestamp?: OnUpdateTimestampFeature;
  fkOnUpdate?: FkOnUpdateFeature;
}

export type FeatureKey = keyof DialectFeatures;

/** 사람에게 보일 기능 이름 (설계 검사 "이 DB에서 쓸 수 없는 기능" 등) */
export const FEATURE_LABEL: Record<FeatureKey, string> = {
  enum: '사용자 정의 타입(ENUM)',
  check: 'CHECK 제약',
  expressionIndex: '식 인덱스',
  partialIndex: '부분 인덱스(WHERE)',
  indexMethods: '인덱스 방식',
  generated: '계산 컬럼',
  onUpdateTimestamp: 'ON UPDATE CURRENT_TIMESTAMP',
  fkOnUpdate: '외래키 ON UPDATE',
};

export { enumInColumn, enumAsTypeObject } from './enum';
export { standardCheck } from './check';
