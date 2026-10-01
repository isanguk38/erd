import type { Change, ChangeCategory, ChangeKind, DiffResult } from './diff';
import { diffSchemas } from './diff';
import type { Dialect } from './dialects/types';
import { emptySchema, type Schema } from './model';

export interface Statement {
  changeId: string;
  category: ChangeCategory;
  tableName: string;
  sql: string;
  warning?: string;
}

/**
 * 실행 순서. 의존 관계 때문에 순서가 중요하다.
 * FK 삭제 → 인덱스 삭제 → 테이블 이름 변경 → 테이블 생성 → 컬럼 변경/추가 → 기본키 → 컬럼 삭제 → 인덱스 생성 → FK 추가 → 테이블 삭제
 */
const PHASE: Record<ChangeKind, number> = {
  dropForeignKey: 1,
  dropIndex: 2,
  renameTable: 3,
  createTable: 4,
  tableComment: 5,
  alterColumn: 6,
  addColumn: 6,
  primaryKey: 7,
  dropColumn: 8,
  addIndex: 9,
  addForeignKey: 10,
  dropTable: 11,
};

function statementsFor(change: Change, diff: DiffResult, dialect: Dialect): string[] {
  switch (change.kind) {
    case 'createTable': return dialect.createTable(change.table);
    case 'dropTable': return dialect.dropTable(change.table);
    case 'renameTable': return dialect.renameTable(change.before, change.after);
    case 'tableComment': return dialect.setTableComment(change.table);
    case 'addColumn': return dialect.addColumn(change.table, change.column, change.previous);
    case 'dropColumn': return dialect.dropColumn(change.table, change.column);
    case 'alterColumn': return dialect.alterColumn(change.table, change.before, change.after, change.fields);
    case 'primaryKey': return dialect.changePrimaryKey(change.before, change.after);
    case 'addIndex': return dialect.createIndex(change.table, change.index);
    case 'dropIndex': return dialect.dropIndex(change.table, change.index);
    case 'addForeignKey': return dialect.addForeignKey(diff.target, change.relation);
    case 'dropForeignKey': return dialect.dropForeignKey(diff.base, change.relation);
  }
}

/**
 * 변경 목록을 실행 순서대로 SQL 문장으로 만든다.
 * selected를 주면 그 변경만 포함한다 (미리보기에서 체크한 항목).
 */
export function generateStatements(diff: DiffResult, dialect: Dialect, selected?: Set<string>): Statement[] {
  const changes = diff.changes
    .filter((c) => !selected || selected.has(c.id))
    .map((change, order) => ({ change, order }))
    .sort((a, b) => PHASE[a.change.kind] - PHASE[b.change.kind] || a.order - b.order);

  const statements: Statement[] = [];
  for (const { change } of changes) {
    statements.push(
      ...statementsFor(change, diff, dialect).map((sql, i) => ({
        changeId: change.id,
        category: change.category,
        tableName: change.tableName,
        sql,
        warning: i === 0 ? change.warning : undefined,
      })),
    );
  }
  return statements;
}

export interface SqlScriptOptions {
  /** 경고를 SQL 주석으로 붙인다 */
  warnings?: boolean;
  /** 이 분류만 넣는다 */
  categories?: ChangeCategory[];
}

export function toScript(statements: Statement[], options: SqlScriptOptions = {}): string {
  const { warnings = true, categories } = options;
  return statements
    .filter((s) => !categories || categories.includes(s.category))
    .map((s) => (warnings && s.warning ? `-- 주의: ${s.warning}\n` : '') + s.sql + ';')
    .join('\n\n');
}

/** 스키마 전체의 CREATE 스크립트 */
export function generateCreateSql(schema: Schema, dialect: Dialect): string {
  return toScript(generateStatements(diffSchemas(emptySchema(), schema, dialect), dialect));
}

/** 기준(이전 버전 또는 지금 DB)에서 목표(지금 ERD)로 가는 변경분 */
export function generateMigration(base: Schema, target: Schema, dialect: Dialect, selected?: Set<string>) {
  const diff = diffSchemas(base, target, dialect);
  const statements = generateStatements(diff, dialect, selected);
  return { diff, statements };
}
