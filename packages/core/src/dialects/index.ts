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

/**
 * 프로젝트의 DB 종류는 만들 때 정하고 바꾸지 않는다 (다른 DB로 바꾸거나 변환하면 문법·타입·기능이 달라 오류가 난다).
 * DB 연결·SQL 등 다른 DB 종류를 쓰려고 하면 이 안내로 막는다.
 */
export function dbmsMismatch(project: DialectId | string, other: DialectId | string, what = 'DB 연결'): string | null {
  if (project === other) return null;
  const label = (id: string) => dialects[id as DialectId]?.label ?? id;
  return `이 프로젝트는 ${label(project)} 프로젝트입니다. ${label(other)} ${what}은(는) 쓸 수 없습니다 (DB 종류는 프로젝트를 만들 때 정하며 바꿀 수 없습니다)`;
}
