import { mysql } from './mysql';
import type { Dialect } from './types';

/**
 * MariaDB: 문법은 MySQL과 같다 (테이블·컬럼 코멘트, AUTO_INCREMENT, MODIFY/CHANGE COLUMN 등).
 * 기본값 표기 차이(current_timestamp(), 따옴표가 붙은 문자열)는 비교할 때 흡수한다.
 */
export const mariadb: Dialect = {
  ...mysql,
  id: 'mariadb',
  label: 'MariaDB',
  typeSuggestions: [...mysql.typeSuggestions, 'UUID', 'INET6'],
  normalizeDefault(value) {
    if (value === null) return null;
    // MariaDB는 함수 기본값을 소문자+괄호로 돌려준다: current_timestamp() → CURRENT_TIMESTAMP
    return mysql.normalizeDefault(value.replace(/^current_timestamp\(\)$/i, 'CURRENT_TIMESTAMP'));
  },
};
