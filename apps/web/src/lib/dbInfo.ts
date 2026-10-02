import { dialects, type DialectId } from '@erd/core';

/** DB 종류별 연결 입력 안내 */
export interface DbInfo {
  port: number;
  databaseLabel: string;
  databasePlaceholder: string;
  /** 스키마 입력칸 (없으면 숨김) */
  schemaPlaceholder?: string;
  /** DDL을 트랜잭션으로 묶어 실패 시 모두 되돌리는지 */
  transactional: boolean;
}

export const DB_INFO: Record<DialectId, DbInfo> = {
  mysql: { port: 3306, databaseLabel: '스키마(DB)', databasePlaceholder: 'shop', transactional: false },
  mariadb: { port: 3306, databaseLabel: '스키마(DB)', databasePlaceholder: 'shop', transactional: false },
  postgresql: { port: 5432, databaseLabel: '데이터베이스', databasePlaceholder: 'postgres', schemaPlaceholder: 'public', transactional: true },
  oracle: { port: 1521, databaseLabel: '서비스 이름', databasePlaceholder: 'FREEPDB1 / ORCLPDB1', schemaPlaceholder: '비우면 접속 사용자', transactional: false },
  mssql: { port: 1433, databaseLabel: '데이터베이스', databasePlaceholder: 'shop', schemaPlaceholder: 'dbo', transactional: true },
};

export const DB_ORDER: DialectId[] = ['mysql', 'mariadb', 'postgresql', 'oracle', 'mssql'];

export function dbLabel(id: string): string {
  return dialects[id as DialectId]?.label ?? id;
}
