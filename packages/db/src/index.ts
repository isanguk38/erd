import type { DialectId } from '@erd/core';
import { mysqlConnector } from './mysql';
import { postgresConnector } from './postgresql';
import type { Connector } from './types';

export * from './types';
export { introspectPostgres, executePostgres, parsePgType, cleanPgDefault, type Queryable } from './postgresql';
export { introspectMysql, mysqlColumnFromRow } from './mysql';

/** DB 종류별 연결. 새 DB는 여기에 등록한다. */
export const connectors: Record<DialectId, Connector> = {
  mysql: mysqlConnector,
  postgresql: postgresConnector,
};

export function getConnector(dialect: DialectId): Connector {
  const connector = connectors[dialect];
  if (!connector) throw new Error(`지원하지 않는 DB입니다: ${dialect}`);
  return connector;
}
export { stabilizeIds } from './stableIds';
