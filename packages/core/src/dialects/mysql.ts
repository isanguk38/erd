import { indexName, primaryKeyColumns, relationName, type Column, type Table } from '../model';
import { columnNames, literal, normalizeDefaultCommon, relationTables, sqlComment, typeWithLength, indexKeys, splitTopLevel } from './common';
import type { Dialect } from './types';

const TYPE_MAP: Record<string, string> = {
  BOOL: 'TINYINT',
  BOOLEAN: 'TINYINT',
  INTEGER: 'INT',
  UUID: 'CHAR',
  BYTEA: 'BLOB',
  TIMESTAMPTZ: 'TIMESTAMP',
  'DOUBLE PRECISION': 'DOUBLE',
  REAL: 'FLOAT',
  NUMERIC: 'DECIMAL',
  JSONB: 'JSON',
  SERIAL: 'INT',
  BIGSERIAL: 'BIGINT',
  'CHARACTER VARYING': 'VARCHAR',
};

const DEFAULT_LENGTH: Record<string, string> = {
  BOOL: '1',
  BOOLEAN: '1',
  UUID: '36',
};

const q = (name: string) => '`' + name.replace(/`/g, '``') + '`';
const str = (v: string) => literal(v, true);

function renderType(column: Column): string {
  const raw = column.type.trim().toUpperCase();
  const type = TYPE_MAP[raw] ?? raw;
  const length = column.length || DEFAULT_LENGTH[raw] || '';
  return typeWithLength(type, length);
}

function columnDefinition(column: Column): string {
  const parts = [q(column.name), renderType(column)];
  parts.push(column.nullable && !column.primaryKey ? 'NULL' : 'NOT NULL');
  if (column.defaultValue !== null && column.defaultValue.trim() !== '') parts.push(`DEFAULT ${column.defaultValue.trim()}`);
  if (column.onUpdate?.trim()) parts.push(`ON UPDATE ${column.onUpdate.trim()}`);
  if (column.autoIncrement) parts.push('AUTO_INCREMENT');
  const comment = sqlComment(column);
  if (comment) parts.push(`COMMENT ${str(comment)}`);
  return parts.join(' ');
}

export const mysql: Dialect = {
  id: 'mysql',
  label: 'MySQL',
  typeSuggestions: [
    'BIGINT', 'INT', 'SMALLINT', 'TINYINT', 'DECIMAL', 'DOUBLE', 'FLOAT', 'BOOLEAN',
    'VARCHAR', 'CHAR', 'TEXT', 'MEDIUMTEXT', 'LONGTEXT',
    'DATE', 'DATETIME', 'TIMESTAMP', 'TIME', 'JSON', 'BLOB', 'ENUM',
  ],

  quote: q,
  renderType,
  normalizeAction: (action) => (action === 'RESTRICT' ? 'NO ACTION' : action),
  normalizeDefault(value) {
    // 덤프(SHOW CREATE TABLE)는 숫자 기본값도 따옴표로 쓴다: DEFAULT '0.00' = 0.00
    const unquoted = value !== null && /^'[-+]?\d+(\.\d+)?'$/.test(value.trim()) ? value.trim().slice(1, -1) : value;
    const v = normalizeDefaultCommon(unquoted);
    if (v === 'TRUE') return '1';
    if (v === 'FALSE') return '0';
    return v;
  },

  createTable(table) {
    const lines = table.columns.map((c) => '  ' + columnDefinition(c));
    const pk = primaryKeyColumns(table);
    if (pk.length) lines.push(`  PRIMARY KEY (${pk.map((c) => q(c.name)).join(', ')})`);
    const comment = sqlComment(table);
    const suffix = comment ? ` COMMENT=${str(comment)}` : '';
    return [`CREATE TABLE ${q(table.name)} (\n${lines.join(',\n')}\n)${suffix}`];
  },
  dropTable: (table) => [`DROP TABLE ${q(table.name)}`],
  renameTable: (from, to) => [`RENAME TABLE ${q(from.name)} TO ${q(to.name)}`],
  setTableComment: (table) => [`ALTER TABLE ${q(table.name)} COMMENT = ${str(sqlComment(table))}`],

  addColumn(table, column, previous) {
    const position = previous ? ` AFTER ${q(previous.name)}` : ' FIRST';
    return [`ALTER TABLE ${q(table.name)} ADD COLUMN ${columnDefinition(column)}${position}`];
  },
  dropColumn: (table, column) => [`ALTER TABLE ${q(table.name)} DROP COLUMN ${q(column.name)}`],
  alterColumn(table, before, after, changed) {
    // MySQL은 컬럼 정의 전체를 다시 쓴다. 이름이 바뀌면 CHANGE, 아니면 MODIFY.
    if (changed.includes('name')) {
      return [`ALTER TABLE ${q(table.name)} CHANGE COLUMN ${q(before.name)} ${columnDefinition(after)}`];
    }
    return [`ALTER TABLE ${q(table.name)} MODIFY COLUMN ${columnDefinition(after)}`];
  },
  changePrimaryKey(before, after) {
    const oldPk = primaryKeyColumns(before);
    const newPk = primaryKeyColumns(after);
    const actions: string[] = [];
    if (oldPk.length) actions.push('DROP PRIMARY KEY');
    if (newPk.length) actions.push(`ADD PRIMARY KEY (${newPk.map((c) => q(c.name)).join(', ')})`);
    return actions.length ? [`ALTER TABLE ${q(after.name)} ${actions.join(', ')}`] : [];
  },

  indexSupport: { expression: true, methods: ['fulltext', 'spatial'] },
  createIndex(table: Table, index) {
    // MySQL은 식마다 괄호를 한 번 더 감싸야 한다: lower(email) → (lower(email))
    const keys = index.expression?.trim() ? mysqlKeyParts(index.expression) : indexKeys(table, index, q);
    // FULLTEXT·SPATIAL 인덱스는 종류를 앞에 붙인다 (UNIQUE와 함께 쓸 수 없다)
    const method = index.method?.trim().toLowerCase();
    const kind = method === 'fulltext' || method === 'spatial' ? `${method.toUpperCase()} ` : index.unique ? 'UNIQUE ' : '';
    return [`CREATE ${kind}INDEX ${q(indexName(table, index))} ON ${q(table.name)} (${keys})`];
  },
  fkNeedsIndex: true,
  dropIndex(table, index, keepForFk = []) {
    if (!keepForFk.length) return [`DROP INDEX ${q(indexName(table, index))} ON ${q(table.name)}`];
    // FK가 이 인덱스를 쓰고 있으면 같은 문장에서 FK 이름의 인덱스를 만든다 (MySQL이 FK용으로 자동으로 만드는 것과 같은 모양 → ERD에는 안 보임)
    const adds = keepForFk.map((k) => `ADD INDEX ${q(k.name)} (${columnNames(table, k.columnIds).map(q).join(', ')})`);
    return [`ALTER TABLE ${q(table.name)} DROP INDEX ${q(indexName(table, index))}, ${adds.join(', ')}`];
  },

  addForeignKey(schema, relation) {
    const { from, to } = relationTables(schema, relation);
    const fromCols = columnNames(from, relation.fromColumnIds).map(q).join(', ');
    const toCols = columnNames(to, relation.toColumnIds).map(q).join(', ');
    let sql = `ALTER TABLE ${q(from.name)} ADD CONSTRAINT ${q(relationName(schema, relation))} FOREIGN KEY (${fromCols}) REFERENCES ${q(to.name)} (${toCols})`;
    if (relation.onDelete !== 'NO ACTION') sql += ` ON DELETE ${relation.onDelete}`;
    if (relation.onUpdate !== 'NO ACTION') sql += ` ON UPDATE ${relation.onUpdate}`;
    return [sql];
  },
  dropForeignKey(schema, relation) {
    const { from } = relationTables(schema, relation);
    return [`ALTER TABLE ${q(from.name)} DROP FOREIGN KEY ${q(relationName(schema, relation))}`];
  },
};

/** 식 인덱스 키: 컬럼 이름은 그대로, 식은 괄호로 한 번 감싼다 (이미 감싸 있으면 그대로) */
export function mysqlKeyParts(expression: string): string {
  return splitTopLevel(expression)
    .map((raw) => {
      const part = raw.trim();
      // 컬럼 이름, 앞부분 길이(col(20)), 정렬 방향은 그대로
      if (/^[`"]?[\w$]+[`"]?(\s*\(\d+\))?(\s+(ASC|DESC))?$/i.test(part)) return part;
      // (식) DESC 도 그대로
      const desc = /\s+(ASC|DESC)$/i.exec(part);
      const body = desc ? part.slice(0, desc.index).trim() : part;
      if (desc && body.startsWith('(') && closingParen(body) === body.length - 1) return part;
      if (part.startsWith('(') && closingParen(part) === part.length - 1) return part;
      return `(${part})`;
    })
    .join(', ');
}

/** 첫 '('와 짝이 맞는 ')'의 위치 */
function closingParen(text: string): number {
  let depth = 0;
  let quote = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return i;
  }
  return -1;
}
