import { dialectList, dialects, type DialectId } from '@erd/core';

/** 새 프로젝트에서 고를 DB 종류 (등록한 순서) */
export const DB_ORDER: DialectId[] = dialectList.map((d) => d.id);

export function dbLabel(id: string): string {
  return dialects[id as DialectId]?.label ?? id;
}
