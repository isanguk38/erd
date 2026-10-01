import { indexName, primaryKeyColumns, relationName, type Column, type Table } from '../model';
import { columnNames, literal, normalizeDefaultCommon, relationTables, sqlComment, typeWithLength } from './common';
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
    const v = normalizeDefaultCommon(value);
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

  createIndex(table: Table, index) {
    const cols = columnNames(table, index.columnIds).map(q).join(', ');
    return [`CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX ${q(indexName(table, index))} ON ${q(table.name)} (${cols})`];
  },
  dropIndex: (table, index) => [`DROP INDEX ${q(indexName(table, index))} ON ${q(table.name)}`],

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
