// 사용자 정의 타입(ENUM) 모듈. ENUM이 있는 DB만 이 모듈을 features.enum에 넣는다.
// - enumInColumn: 타입 객체 없이 컬럼마다 ENUM('a','b')으로 만든다 (MySQL·MariaDB)
// - enumAsTypeObject: CREATE TYPE으로 타입을 따로 만든다 (PostgreSQL) — SQL은 그 DB가 넘긴다
// ENUM 목록·이름 맞추기 등 DB와 상관없는 부분은 enums.ts에 있다.

import { enumValueList } from '../enums';
import type { Column, EnumType } from '../model';
import type { EnumFeature } from './index';

export const enumInColumn: EnumFeature = {
  kind: 'column',
  resolveColumn: (column, e) => ({ ...column, type: 'ENUM', length: enumValueList(e.values) }),
  help: '타입 객체가 없어 이 타입을 쓰는 컬럼마다 ENUM(\'값\', ...)으로 만듭니다. 값을 바꾸면 그 컬럼들의 타입이 바뀝니다.',
};

/** 타입 객체를 따로 만드는 DB: typeName은 그 DB에서 타입을 가리키는 이름(따옴표 포함) */
export function enumAsTypeObject(sql: {
  typeName(name: string): string;
  create(e: EnumType): string[];
  drop(e: EnumType): string[];
  alter(before: EnumType, after: EnumType, usages: { table: string; column: Column }[]): string[];
  help: string;
}): EnumFeature {
  return {
    kind: 'type',
    resolveColumn: (column, e) => ({ ...column, type: sql.typeName(e.name), length: '' }),
    create: sql.create,
    drop: sql.drop,
    alter: sql.alter,
    help: sql.help,
  };
}
