import { indexName, primaryKeyColumns, relationName, type Column, type Table } from '../model';
import { columnNames, normalizeDefaultCommon, relationTables, sqlComment, typeWithLength, indexKeys, indexWhere } from './common';
import type { Dialect } from './types';

// SQL Server 2016 이상. 이름은 [대괄호], 코멘트는 확장 속성(MS_Description),
// 기본값은 이름이 정해지지 않은 제약조건이라 바꾸거나 지울 때 이름을 찾아 지운다.

const TYPE_MAP: Record<string, string> = {
  BOOLEAN: 'BIT',
  BOOL: 'BIT',
  TEXT: 'NVARCHAR(MAX)',
  TINYTEXT: 'NVARCHAR(MAX)',
  MEDIUMTEXT: 'NVARCHAR(MAX)',
  LONGTEXT: 'NVARCHAR(MAX)',
  CLOB: 'NVARCHAR(MAX)',
  JSON: 'NVARCHAR(MAX)',
  JSONB: 'NVARCHAR(MAX)',
  DATETIME: 'DATETIME2',
  TIMESTAMP: 'DATETIME2',
  TIMESTAMPTZ: 'DATETIMEOFFSET',
  DOUBLE: 'FLOAT',
  'DOUBLE PRECISION': 'FLOAT',
  NUMERIC: 'DECIMAL',
  NUMBER: 'DECIMAL',
  BLOB: 'VARBINARY(MAX)',
  LONGBLOB: 'VARBINARY(MAX)',
  BYTEA: 'VARBINARY(MAX)',
  UUID: 'UNIQUEIDENTIFIER',
  INTEGER: 'INT',
  INT4: 'INT',
  SERIAL: 'INT',
  MEDIUMINT: 'INT',
  INT8: 'BIGINT',
  BIGSERIAL: 'BIGINT',
  INT2: 'SMALLINT',
  VARCHAR2: 'VARCHAR',
  NVARCHAR2: 'NVARCHAR',
  'CHARACTER VARYING': 'VARCHAR',
};

const NO_LENGTH = new Set(['INT', 'BIGINT', 'SMALLINT', 'TINYINT', 'BIT', 'DATE', 'DATETIME2', 'DATETIMEOFFSET', 'FLOAT', 'REAL', 'UNIQUEIDENTIFIER', 'MONEY', 'SMALLDATETIME', 'XML', 'TIME']);

const q = (name: string) => '[' + name.replace(/]/g, ']]') + ']';
/** N'...' 문자열 */
const nstr = (v: string) => `N'${v.replace(/'/g, "''")}'`;

function renderType(column: Column): string {
  const raw = column.type.trim().toUpperCase().replace(/\s+(UNSIGNED|ZEROFILL)/g, '');
  const mapped = TYPE_MAP[raw] ?? raw;
  if (mapped.includes('(')) return mapped;
  if (NO_LENGTH.has(mapped)) return mapped;
  let length = column.length.replace(/\s+/g, '');
  if (length === '-1') length = 'MAX';
  if (!length && /^N?VARCHAR$|^VARBINARY$/.test(mapped)) length = '255';
  return typeWithLength(mapped, length.toUpperCase() === 'MAX' ? 'MAX' : length);
}

function defaultValue(column: Column): string {
  const v = column.defaultValue?.trim();
  if (!v) return '';
  if (/^true$/i.test(v)) return '1';
  if (/^false$/i.test(v)) return '0';
  return v;
}

function columnDefinition(column: Column): string {
  const generated = column.generated?.expression.trim();
  // NOT NULL은 PERSISTED일 때만 쓸 수 있다
  if (generated) return `${q(column.name)} AS (${generated})${column.generated!.stored ? ` PERSISTED${!column.nullable || column.primaryKey ? ' NOT NULL' : ''}` : ''}`;
  let def = `${q(column.name)} ${renderType(column)}`;
  if (column.autoIncrement) def += ' IDENTITY(1,1)';
  def += column.nullable && !column.primaryKey ? ' NULL' : ' NOT NULL';
  const v = defaultValue(column);
  if (v && !column.autoIncrement) def += ` DEFAULT ${v}`;
  return def;
}

/** 컬럼의 기본값 제약조건을 찾아 지운다 (이름이 DB가 자동으로 지은 것이어도) */
function dropDefault(table: Table, column: Column): string {
  return (
    `DECLARE @df sysname; SELECT @df = dc.name FROM sys.default_constraints dc ` +
    `JOIN sys.columns c ON c.object_id = dc.parent_object_id AND c.column_id = dc.parent_column_id ` +
    `WHERE dc.parent_object_id = OBJECT_ID(${nstr(q(table.name))}) AND c.name = ${nstr(column.name)}; ` +
    `IF @df IS NOT NULL EXEC(N'ALTER TABLE ' + ${nstr(q(table.name))} + N' DROP CONSTRAINT [' + @df + N']')`
  );
}

/** 테이블·컬럼 설명(MS_Description)을 지우고 다시 쓴다 */
function description(table: Table, column: Column | null): string {
  const text = sqlComment(column ?? table);
  const level2 = column ? `, @level2type = N'COLUMN', @level2name = ${nstr(column.name)}` : '';
  const minor = column ? `COLUMNPROPERTY(OBJECT_ID(${nstr(q(table.name))}), ${nstr(column.name)}, 'ColumnId')` : '0';
  const args = `@name = N'MS_Description', @level0type = N'SCHEMA', @level0name = @s, @level1type = N'TABLE', @level1name = ${nstr(table.name)}${level2}`;
  return (
    `DECLARE @s sysname = SCHEMA_NAME(); ` +
    `IF EXISTS (SELECT 1 FROM sys.extended_properties WHERE major_id = OBJECT_ID(${nstr(q(table.name))}) AND minor_id = ${minor} AND name = N'MS_Description') ` +
    `EXEC sp_dropextendedproperty ${args};` +
    (text ? ` EXEC sp_addextendedproperty ${args.replace("@name = N'MS_Description'", `@name = N'MS_Description', @value = ${nstr(text)}`)};` : '')
  );
}

const pkName = (table: Table) => table.primaryKeyName || `PK_${table.name}`;
const fail = (message: string) => `RAISERROR(${nstr(message)}, 16, 1)`;

export const mssql: Dialect = {
  id: 'mssql',
  label: 'SQL Server',
  typeSuggestions: ['BIGINT', 'INT', 'SMALLINT', 'TINYINT', 'BIT', 'DECIMAL', 'FLOAT', 'NVARCHAR', 'VARCHAR', 'NCHAR', 'CHAR', 'DATE', 'DATETIME2', 'DATETIMEOFFSET', 'TIME', 'UNIQUEIDENTIFIER', 'VARBINARY'],

  quote: q,
  renderType,
  normalizeAction: (action) => (action === 'RESTRICT' ? 'NO ACTION' : action),
  normalizeDefault(value) {
    if (value === null) return null;
    // SQL Server는 기본값을 괄호로 감싸 돌려준다: ('A'), ((0)), (getdate())
    let v = value.trim();
    while (/^\(.*\)$/s.test(v) && balanced(v.slice(1, -1))) v = v.slice(1, -1).trim();
    // N'..' → '..'
    v = v.replace(/^N'/i, "'");
    const n = normalizeDefaultCommon(v);
    if (n === 'GETDATE()' || n === 'SYSDATETIME()' || n === 'CURRENT_TIMESTAMP') return 'CURRENT_TIMESTAMP';
    if (n === 'TRUE') return '1';
    if (n === 'FALSE') return '0';
    return n;
  },

  createTable(table) {
    const lines = table.columns.map((c) => '  ' + columnDefinition(c));
    const pk = primaryKeyColumns(table);
    if (pk.length) lines.push(`  CONSTRAINT ${q(pkName(table))} PRIMARY KEY (${pk.map((c) => q(c.name)).join(', ')})`);
    const statements = [`CREATE TABLE ${q(table.name)} (\n${lines.join(',\n')}\n)`];
    if (sqlComment(table)) statements.push(description(table, null));
    for (const c of table.columns) if (sqlComment(c)) statements.push(description(table, c));
    return statements;
  },
  dropTable: (table) => [`DROP TABLE ${q(table.name)}`],
  renameTable: (from, to) => [`EXEC sp_rename ${nstr(q(from.name))}, ${nstr(to.name)}`],
  setTableComment: (table) => [description(table, null)],

  addColumn(table, column) {
    const statements = [`ALTER TABLE ${q(table.name)} ADD ${columnDefinition(column)}`];
    if (sqlComment(column)) statements.push(description(table, column));
    return statements;
  },
  // 기본값 제약조건이 있으면 컬럼을 지울 수 없으므로 먼저 지운다
  dropColumn: (table, column) => [dropDefault(table, column), `ALTER TABLE ${q(table.name)} DROP COLUMN ${q(column.name)}`],
  alterColumn(table, before, after, changed, beforeTable) {
    const t = q(table.name);
    const statements: string[] = [];
    // 이 컬럼을 쓰는 인덱스가 있으면 타입·NULL을 바꿀 수 없다 → 그대로 남는 인덱스만 잠깐 지웠다 다시 만든다
    const retype = changed.includes('type') || changed.includes('nullable');
    const keep = retype && beforeTable
      ? table.indexes.filter((i) => i.columnIds.includes(after.id) && beforeTable.indexes.some((b) => b.id === i.id && b.name === i.name && b.unique === i.unique && b.columnIds.join() === i.columnIds.join()))
      : [];
    for (const i of keep) statements.push(...mssql.dropIndex(beforeTable!, i));
    if (changed.includes('name')) statements.push(`EXEC sp_rename ${nstr(`${q(table.name)}.${q(before.name)}`)}, ${nstr(after.name)}, N'COLUMN'`);
    if (changed.includes('autoIncrement')) {
      statements.push(fail(`SQL Server는 기존 컬럼에 IDENTITY를 넣거나 뺄 수 없습니다: ${table.name}.${after.name} (새 컬럼을 만들어 옮기세요)`));
    }
    if (retype) {
      statements.push(`ALTER TABLE ${t} ALTER COLUMN ${q(after.name)} ${renderType(after)} ${after.nullable && !after.primaryKey ? 'NULL' : 'NOT NULL'}`);
    }
    for (const i of keep) statements.push(...mssql.createIndex(table, i));
    if (changed.includes('defaultValue')) {
      statements.push(dropDefault(table, after));
      const v = defaultValue(after);
      if (v && !after.autoIncrement) statements.push(`ALTER TABLE ${t} ADD DEFAULT ${v} FOR ${q(after.name)}`);
    }
    if (changed.includes('comment')) statements.push(description(table, after));
    return statements;
  },
  changePrimaryKey(before, after) {
    const statements: string[] = [];
    if (primaryKeyColumns(before).length) statements.push(`ALTER TABLE ${q(after.name)} DROP CONSTRAINT ${q(pkName(before))}`);
    const newPk = primaryKeyColumns(after);
    if (newPk.length) statements.push(`ALTER TABLE ${q(after.name)} ADD CONSTRAINT ${q(`PK_${after.name}`)} PRIMARY KEY (${newPk.map((c) => q(c.name)).join(', ')})`);
    return statements;
  },

  indexSupport: { where: true },
  generatedSupport: { virtual: true, stored: true, typed: false },
  createIndex(table, index) {
    return [`CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX ${q(indexName(table, index))} ON ${q(table.name)} (${indexKeys(table, index, q)})${indexWhere(index)}`];
  },
  dropIndex: (table, index) =>
    index.isConstraint
      ? [`ALTER TABLE ${q(table.name)} DROP CONSTRAINT ${q(indexName(table, index))}`]
      : [`DROP INDEX ${q(indexName(table, index))} ON ${q(table.name)}`],

  addForeignKey(schema, relation) {
    const { from, to } = relationTables(schema, relation);
    const fromCols = columnNames(from, relation.fromColumnIds).map(q).join(', ');
    const toCols = columnNames(to, relation.toColumnIds).map(q).join(', ');
    let sql = `ALTER TABLE ${q(from.name)} ADD CONSTRAINT ${q(relationName(schema, relation))} FOREIGN KEY (${fromCols}) REFERENCES ${q(to.name)} (${toCols})`;
    const action = (a: string) => (a === 'RESTRICT' ? 'NO ACTION' : a);
    if (action(relation.onDelete) !== 'NO ACTION') sql += ` ON DELETE ${relation.onDelete}`;
    if (action(relation.onUpdate) !== 'NO ACTION') sql += ` ON UPDATE ${relation.onUpdate}`;
    return [sql];
  },
  dropForeignKey(schema, relation) {
    const { from } = relationTables(schema, relation);
    return [`ALTER TABLE ${q(from.name)} DROP CONSTRAINT ${q(relationName(schema, relation))}`];
  },
};

/** 괄호 짝이 맞는지 ((A)) → 바깥 괄호를 벗겨도 되는지 */
function balanced(s: string): boolean {
  let depth = 0;
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "'") inStr = !inStr;
    if (inStr) continue;
    if (ch === '(') depth++;
    if (ch === ')' && --depth < 0) return false;
  }
  return depth === 0;
}
