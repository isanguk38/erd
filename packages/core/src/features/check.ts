// CHECK 제약 모듈. 대부분의 DB는 ALTER TABLE ... ADD/DROP CONSTRAINT로 같다 (standardCheck).
// 지우는 문법이 다른 DB는 drop만 바꿔 넣는다 (MySQL: DROP CHECK).

import { checkName, type CheckConstraint, type Table } from '../model';
import { quoteExpression } from '../dialects/common';
import type { CheckFeature } from './index';

export function standardCheck(q: (name: string) => string, override: Partial<CheckFeature> = {}): CheckFeature {
  return {
    add: (table: Table, check: CheckConstraint) => [`ALTER TABLE ${q(table.name)} ADD CONSTRAINT ${q(checkName(table, check))} CHECK (${quoteExpression(check.expression.trim(), q)})`],
    drop: (table: Table, check: CheckConstraint) => [`ALTER TABLE ${q(table.name)} DROP CONSTRAINT ${q(checkName(table, check))}`],
    ...override,
  };
}
