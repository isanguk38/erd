import type { DialectId, Schema } from '@erd/core';

export interface ConnectionConfig {
  dialect: DialectId;
  host: string;
  port: number;
  user: string;
  password: string;
  /** MySQL: 스키마(DB) 이름, PostgreSQL: 데이터베이스 이름 */
  database: string;
  /** PostgreSQL 스키마 (기본 public) */
  schema?: string;
  ssl?: boolean;
}

export interface IntrospectOptions {
  /** DB 코멘트를 논리명으로 쓸지 설명으로 쓸지 */
  commentAs?: 'logicalName' | 'comment';
}

export interface IntrospectResult {
  schema: Schema;
  serverVersion: string;
  warnings: string[];
}

export interface StatementResult {
  sql: string;
  ok: boolean;
  error?: string;
  ms: number;
  /** 앞 문장이 실패해서 실행하지 않음 */
  skipped?: boolean;
}

export interface ExecuteResult {
  results: StatementResult[];
  /** 모두 성공했는지 */
  ok: boolean;
  /** PostgreSQL: 실패 시 트랜잭션이 되돌려졌는지 */
  rolledBack: boolean;
  /** MySQL처럼 DDL이 바로 반영되는 DB에서, 실패 전까지 반영된 문장 수 */
  appliedCount: number;
}

/**
 * DB 종류별 연결. 새 DB를 추가하려면 이 인터페이스를 구현해 connectors에 등록한다.
 */
export interface Connector {
  dialect: DialectId;
  test(config: ConnectionConfig): Promise<{ serverVersion: string }>;
  introspect(config: ConnectionConfig, options?: IntrospectOptions): Promise<IntrospectResult>;
  /** 문장을 순서대로 실행한다. 트랜잭션 DDL을 지원하면 하나의 트랜잭션으로 묶는다. */
  execute(config: ConnectionConfig, statements: string[]): Promise<ExecuteResult>;
}
