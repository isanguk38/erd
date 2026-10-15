// DB 객체 모듈 만들기 (뷰·함수·프로시저·트리거·이벤트·패키지). 각 DBMS 파일이 자기 종류·지우는 문법·예시를 넣는다.

import type { DbObject, DbObjectKind } from '../dbObjects';
import type { DbObjectsFeature } from './index';

/** PL/SQL처럼 끝의 ;가 문장의 일부인 종류 (Oracle 함수·프로시저·트리거·패키지) */
type Terminator = (kind: DbObjectKind) => 'keep' | 'strip';

interface ObjectsModuleOptions {
  kinds: DbObjectKind[];
  /** 이름 따옴표 */
  quote: (name: string) => string;
  /** 지우는 SQL (종류별) */
  drop: Partial<Record<DbObjectKind, (o: DbObject, q: (name: string) => string) => string>>;
  /** CREATE OR REPLACE로 바로 바꿀 수 있는 종류 (지우지 않고 다시 만든다 — 권한·의존하는 것을 지키려고) */
  replaceable?: DbObjectKind[];
  /** 새로 만들기 예시 */
  templates: Partial<Record<DbObjectKind, (name: string, table: string) => string>>;
  /** 끝의 ;를 남길 종류 (기본: 모두 뺀다) */
  terminator?: Terminator;
}

/** 끝의 ; / (SQL*Plus 구분자)를 정리한다. keep이면 PL/SQL 끝의 ; 하나는 남긴다 */
export function trimTerminator(sql: string, keep: boolean): string {
  const body = sql.replace(/\r\n?/g, '\n').replace(/\n\s*\/\s*$/, '').trimEnd().replace(/;+\s*$/, '');
  return keep ? `${body};` : body;
}

export function dbObjectsModule(options: ObjectsModuleOptions): DbObjectsFeature {
  const { kinds, quote, drop, replaceable = [], templates, terminator = () => 'strip' } = options;
  const create = (o: DbObject) => [trimTerminator(o.definition, terminator(o.kind) === 'keep')];
  return {
    kinds,
    create,
    drop: (o) => {
      const make = drop[o.kind];
      return make ? [make(o, quote)] : [];
    },
    alter: (before, after) =>
      replaceable.includes(after.kind) && before.kind === after.kind && /^\s*CREATE\s+OR\s+(REPLACE|ALTER)\b/i.test(after.definition)
        ? { drop: [], create: create(after) }
        : { drop: drop[before.kind] ? [drop[before.kind]!(before, quote)] : [], create: create(after) },
    template: (kind, name, table) => templates[kind]?.(name, table || 'table_name') ?? '',
  };
}
