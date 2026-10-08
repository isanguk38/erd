import type { DialectId } from '@erd/core';
import { mariadbConnector, mysqlConnector } from './mysql';
import { oracleConnector } from './oracle';
import { mssqlConnector } from './mssql';
import { postgresConnector } from './postgresql';
import type { Connector } from './types';

export * from './types';
export { introspectPostgres, executePostgres, parsePgType, cleanPgDefault, type Queryable } from './postgresql';
export { introspectMysql, mysqlColumnFromRow } from './mysql';
export { introspectOracle, oracleType, oracleDefault, fromOracleName } from './oracle';
export { introspectMssql, mssqlType, mssqlDefault } from './mssql';

/** DB 종류별 연결. 새 DB는 여기에 등록한다. */
export const connectors: Record<DialectId, Connector> = {
  mysql: mysqlConnector,
  mariadb: mariadbConnector,
  postgresql: postgresConnector,
  oracle: oracleConnector,
  mssql: mssqlConnector,
};

export function getConnector(dialect: DialectId): Connector {
  const connector = connectors[dialect];
  if (!connector) throw new Error(`지원하지 않는 DB입니다: ${dialect}`);
  return connector;
}
export { stabilizeIds } from './stableIds';
export { validateChecks, runSafetyChecks } from './safety';
