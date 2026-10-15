import { checkName } from '../model';
import { MYSQL_KNOWN, mysql, mysqlTypes } from './mysql';
import { typeWords } from './common';
import type { Dialect } from './types';
import { standardCheck } from '../features';

/**
 * MariaDB: 문법은 MySQL과 같다 (테이블·컬럼 코멘트, AUTO_INCREMENT, MODIFY/CHANGE COLUMN 등).
 * 기본값 표기 차이(current_timestamp(), 따옴표가 붙은 문자열)는 비교할 때 흡수한다.
 */
export const mariadb: Dialect = {
  ...mysql,
  id: 'mariadb',
  label: 'MariaDB',
  typeSuggestions: [...mysql.typeSuggestions, 'UUID', 'INET6'],
  // MySQL과 다른 점: 소수 자릿수 최대 38, ON UPDATE·기본값 시각 자릿수 차이를 받는다, TEXT 기본값을 받는다 (실제 서버로 확인)
  types: {
    ...mysqlTypes,
    known: typeWords(`${MYSQL_KNOWN} UUID INET4 INET6 VECTOR`),
    decimal: { types: typeWords('DECIMAL NUMERIC'), p: 65, s: 38, sWithinP: true },
    onUpdatePrecisionStrict: undefined,
    defaultTimeStrict: undefined,
    lobNoLiteralDefault: undefined,
  },
  // 식 인덱스는 없다 (가상 컬럼을 만들어 인덱스를 건다) — expressionIndex 모듈을 넣지 않는다
  features: {
    enum: mysql.features.enum,
    check: standardCheck(mysql.quote),
    indexMethods: mysql.features.indexMethods,
    generated: { virtual: true, stored: true },
    onUpdateTimestamp: mysql.features.onUpdateTimestamp,
    fkOnUpdate: mysql.features.fkOnUpdate,
    objects: mysql.features.objects,
  },
  normalizeDefault(value) {
    if (value === null) return null;
    // MariaDB는 함수 기본값을 소문자+괄호로 돌려준다: current_timestamp() → CURRENT_TIMESTAMP
    return mysql.normalizeDefault(value.replace(/^current_timestamp\(\)$/i, 'CURRENT_TIMESTAMP'));
  },
};
