import { mysql } from './mysql';
import { mariadb } from './mariadb';
import { postgresql } from './postgresql';
import { oracle } from './oracle';
import { mssql } from './mssql';
import type { Dialect, DialectId } from './types';

export type { Dialect, DialectId, ColumnField } from './types';

/** 지원하는 DB 목록. 새 DB는 여기에 등록한다. */
export const dialects: Record<DialectId, Dialect> = {
  mysql,
  mariadb,
  postgresql,
  oracle,
  mssql,
};

export function getDialect(id: DialectId): Dialect {
  const dialect = dialects[id];
  if (!dialect) throw new Error(`지원하지 않는 DB입니다: ${id}`);
  return dialect;
}

export const dialectList: Dialect[] = Object.values(dialects);
