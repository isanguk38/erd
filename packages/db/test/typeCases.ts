// 타입 검사(typeRules)가 "실패"라고 한 것이 실제 DB에서도 실패하는지, 통과라고 한 것은 실제로 만들어지는지 맞춰 보는 사례 목록.
// 각 DB의 실제 서버 테스트(*.integration.test.ts)에서 실행한다.

import { applyCommands, diffSchemas, emptySchema, generateStatements, getDialect, tableTypeIssues, type DialectId } from '@erd/core';

type ColumnSpec = Record<string, unknown>;
interface TypeCase {
  label: string;
  columns: ColumnSpec[];
  /** 이 DB에서만 */
  only?: DialectId[];
}

const id = { name: 'id', type: 'INT', primaryKey: true };
const CASES: TypeCase[] = [
  { label: 'VARCHAR 자동 증가', columns: [{ name: 'id', type: 'VARCHAR', length: '255', primaryKey: true, autoIncrement: true }] },
  { label: 'BIGINT 자동 증가', columns: [{ name: 'id', type: 'BIGINT', primaryKey: true, autoIncrement: true }] },
  { label: 'DECIMAL(10,2) 자동 증가', columns: [{ name: 'id', type: 'DECIMAL', length: '10,2', primaryKey: true, autoIncrement: true }] },
  { label: '자동 증가 둘', columns: [{ name: 'id', type: 'BIGINT', primaryKey: true, autoIncrement: true }, { name: 'b', type: 'INT', autoIncrement: true, unique: true }] },
  { label: '기본키가 아닌 자동 증가 + UNIQUE', columns: [{ name: 'id', type: 'BIGINT', primaryKey: true }, { name: 'b', type: 'INT', autoIncrement: true, unique: true }] },
  { label: '기본키가 아닌 자동 증가 (키 없음)', columns: [{ name: 'id', type: 'BIGINT', primaryKey: true }, { name: 'b', type: 'INT', autoIncrement: true }] },
  { label: '자동 증가 + 기본값', columns: [{ name: 'id', type: 'BIGINT', primaryKey: true, autoIncrement: true, default: '0' }] },
  { label: 'DATETIME(255)', columns: [id, { name: 'd', type: 'DATETIME', length: '255', nullable: true }] },
  { label: 'DATETIME(6)', columns: [id, { name: 'd', type: 'DATETIME', length: '6', nullable: true }] },
  { label: 'DATE(10)', columns: [id, { name: 'd', type: 'DATE', length: '10', nullable: true }] },
  { label: 'JSON(100)', columns: [id, { name: 'd', type: 'JSON', length: '100', nullable: true }] },
  { label: 'VARCHAR 길이 없음', columns: [id, { name: 'd', type: 'VARCHAR', length: '', nullable: true }] },
  { label: 'VARCHAR(20000)', columns: [id, { name: 'd', type: 'VARCHAR', length: '20000', nullable: true }] },
  { label: 'VARCHAR(8000)', columns: [id, { name: 'd', type: 'VARCHAR', length: '8000', nullable: true }] },
  { label: 'NVARCHAR(5000)', columns: [id, { name: 'd', type: 'NVARCHAR', length: '5000', nullable: true }], only: ['mssql'] },
  { label: 'NVARCHAR(MAX)', columns: [id, { name: 'd', type: 'NVARCHAR', length: 'MAX', nullable: true }], only: ['mssql'] },
  { label: 'CHAR(3000)', columns: [id, { name: 'd', type: 'CHAR', length: '3000', nullable: true }] },
  { label: 'DECIMAL(70,2)', columns: [id, { name: 'd', type: 'DECIMAL', length: '70,2', nullable: true }] },
  { label: 'DECIMAL(39,2)', columns: [id, { name: 'd', type: 'DECIMAL', length: '39,2', nullable: true }] },
  { label: 'DECIMAL(5,6)', columns: [id, { name: 'd', type: 'DECIMAL', length: '5,6', nullable: true }] },
  { label: 'INT(300)', columns: [id, { name: 'd', type: 'INT', length: '300', nullable: true }] },
  { label: 'TEXT 기본값', columns: [id, { name: 'd', type: 'TEXT', nullable: true, default: "'x'" }], only: ['mysql', 'mariadb'] },
  { label: 'ON UPDATE 자릿수 다름', columns: [id, { name: 'd', type: 'DATETIME', length: '3', nullable: true, onUpdate: 'CURRENT_TIMESTAMP' }], only: ['mysql', 'mariadb'] },
  { label: 'ON UPDATE VARCHAR', columns: [id, { name: 'd', type: 'VARCHAR', length: '10', nullable: true, onUpdate: 'CURRENT_TIMESTAMP' }], only: ['mysql', 'mariadb'] },
  { label: 'DATE 기본값 CURRENT_TIMESTAMP', columns: [id, { name: 'd', type: 'DATE', nullable: true, default: 'CURRENT_TIMESTAMP' }], only: ['mysql', 'mariadb'] },
  { label: '행 크기 초과', columns: [id, { name: 'a', type: 'VARCHAR', length: '10000', nullable: true }, { name: 'b', type: 'VARCHAR', length: '8000', nullable: true }], only: ['mysql', 'mariadb'] },
];

/**
 * 사례마다 테이블을 만들어 보고, 타입 검사의 판단(오류 있음 = 실패)과 실제 결과가 다른 것을 돌려준다.
 * 경고(설정에 따라 다름)만 있는 사례는 비교하지 않는다.
 * exec: 문장들을 실행하고 실패하면 오류 문구, 성공하면 null
 */
export async function typeRuleMismatches(dialectId: DialectId, exec: (statements: string[]) => Promise<string | null>): Promise<string[]> {
  const dialect = getDialect(dialectId);
  const mismatches: string[] = [];
  let n = 0;
  for (const c of CASES) {
    if (c.only && !c.only.includes(dialectId)) continue;
    const name = `t_type_${++n}`;
    const { schema } = applyCommands(emptySchema(), [{ op: 'createTable', name, columns: c.columns }] as never);
    const issues = tableTypeIssues(dialect, schema.tables[0]!);
    if (issues.some((i) => i.severity === 'warning')) continue;
    const predicted = issues.filter((i) => i.severity === 'error').map((i) => i.code);
    const sqls = generateStatements(diffSchemas(emptySchema(), schema, dialect), dialect).map((s) => s.sql);
    const error = await exec(sqls);
    if (Boolean(error) !== predicted.length > 0) {
      mismatches.push(`${c.label}: DB ${error ? `실패 (${error.slice(0, 120)})` : '성공'} / 검사 ${predicted.join(',') || '문제 없음'}`);
    }
  }
  return mismatches;
}
