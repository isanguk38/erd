import { checkName, indexName, primaryKeyColumns, relationName, type Column, type Index, type Table } from '../model';
import { columnNames, limitCount, typeWords, literal, normalizeDefaultCommon, numericRegex, relationTables, sqlComment, typeWithLength, indexKeys, splitTopLevel } from './common';
import type { Dialect, TypeProfile } from './types';
import { dbObjectsModule, enumInColumn, standardCheck } from '../features';

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
  const generated = column.generated?.expression.trim();
  if (generated) {
    parts.push(`GENERATED ALWAYS AS (${generated}) ${column.generated!.stored ? 'STORED' : 'VIRTUAL'}`);
    // MariaDB는 계산 컬럼 뒤에 NULL을 쓸 수 없다 → NULL 허용은 생략하고 NOT NULL만 쓴다
    if (!column.nullable || column.primaryKey) parts.push('NOT NULL');
    const comment = sqlComment(column);
    if (comment) parts.push(`COMMENT ${str(comment)}`);
    return parts.join(' ');
  }
  parts.push(column.nullable && !column.primaryKey && !column.autoIncrement ? 'NULL' : 'NOT NULL');
  if (column.defaultValue !== null && column.defaultValue.trim() !== '') parts.push(`DEFAULT ${column.defaultValue.trim()}`);
  if (column.onUpdate?.trim()) parts.push(`ON UPDATE ${column.onUpdate.trim()}`);
  if (column.autoIncrement) parts.push('AUTO_INCREMENT');
  const comment = sqlComment(column);
  if (comment) parts.push(`COMMENT ${str(comment)}`);
  return parts.join(' ');
}

/** 기본키 첫 컬럼이 아닌 AUTO_INCREMENT 컬럼의 키가 될 인덱스. MySQL은 CREATE TABLE 때 이미 키가 있어야 해서 테이블 안에 함께 만든다 */
function autoIncrementKey(table: Table): Index | undefined {
  const auto = table.columns.find((c) => c.autoIncrement && !c.generated?.expression.trim());
  if (!auto || primaryKeyColumns(table)[0]?.id === auto.id) return undefined;
  const candidates = table.indexes.filter((i) => !i.expression?.trim() && !i.method?.trim() && i.columnIds[0] === auto.id);
  return candidates.find((i) => i.unique) ?? candidates[0];
}

/** MySQL이 아는 타입 이름 (MariaDB도 이것을 바탕으로 쓴다) */
export const MYSQL_KNOWN = 'TINYINT SMALLINT MEDIUMINT MIDDLEINT INT INTEGER BIGINT INT1 INT2 INT3 INT4 INT8 DECIMAL DEC NUMERIC FIXED FLOAT DOUBLE REAL BIT BOOL BOOLEAN SERIAL ' +
  'DATE DATETIME TIMESTAMP TIME YEAR CHAR CHARACTER VARCHAR NCHAR NVARCHAR NATIONAL BINARY VARBINARY TINYBLOB BLOB MEDIUMBLOB LONGBLOB ' +
  'TINYTEXT TEXT MEDIUMTEXT LONGTEXT LONG ENUM SET JSON GEOMETRY POINT LINESTRING POLYGON MULTIPOINT MULTILINESTRING MULTIPOLYGON GEOMETRYCOLLECTION GEOMCOLLECTION';
const MYSQL_LOB = /^(TINY|MEDIUM|LONG)?(TEXT|BLOB)$|^JSON$|^GEOMETRY$/;

/** MySQL 한 행 크기(바이트) 어림값. TEXT·BLOB은 행 밖에 저장되어 몇 바이트만 센다 (utf8mb4: 한 글자 4바이트) */
export function mysqlRowBytes(columns: Column[]): { bytes: number; widest?: Column } {
  const FIXED: Record<string, number> = { TINYINT: 1, SMALLINT: 2, MEDIUMINT: 3, INT: 4, INTEGER: 4, BIGINT: 8, FLOAT: 4, DOUBLE: 8, DATE: 3, TIME: 6, DATETIME: 8, TIMESTAMP: 7, YEAR: 1, BOOLEAN: 1, BOOL: 1 };
  let bytes = Math.ceil(columns.filter((c) => c.nullable && !c.primaryKey).length / 8);
  let widest: Column | undefined;
  let widestBytes = 0;
  for (const c of columns) {
    if (c.generated?.expression.trim() && !c.generated.stored) continue;
    const m = renderType(c).toUpperCase().match(/^([A-Z ]+?)\s*(?:\(([^)]*)\))?(?:\s.*)?$/);
    const base = (m?.[1] ?? '').trim();
    const n = Number.parseInt(m?.[2] ?? '', 10) || 0;
    let size: number;
    if (base === 'VARCHAR') size = n * 4 + (n * 4 > 255 ? 2 : 1);
    else if (base === 'CHAR') size = n * 4;
    else if (base === 'VARBINARY') size = n + (n > 255 ? 2 : 1);
    else if (base === 'BINARY') size = n;
    else if (base === 'DECIMAL' || base === 'NUMERIC') size = Math.ceil((n || 10) / 2) + 1;
    else if (MYSQL_LOB.test(base)) size = 12;
    else size = FIXED[base] ?? 8;
    bytes += size;
    if ((base === 'VARCHAR' || base === 'CHAR') && size > widestBytes) {
      widest = c;
      widestBytes = size;
    }
  }
  return { bytes, widest };
}

/** MySQL 타입 정보 (컬럼 타입 검사가 쓴다) */
export const mysqlTypes: TypeProfile = {
  known: typeWords(MYSQL_KNOWN),
  autoIncrement: {
    label: 'AUTO_INCREMENT',
    integers: typeWords('TINYINT SMALLINT MEDIUMINT INT INTEGER BIGINT'),
    floatDeprecated: true,
    defaultValue: 'error',
    single: true,
    mustBeKey: true,
  },
  fraction: { types: typeWords('DATETIME TIMESTAMP TIME'), over: 'error' },
  noLength: typeWords('DATE JSON TINYTEXT MEDIUMTEXT LONGTEXT TINYBLOB MEDIUMBLOB LONGBLOB GEOMETRY POINT LINESTRING POLYGON'),
  lengthRequired: typeWords('VARCHAR VARBINARY'),
  // utf8mb4 기준 (한 글자 최대 4바이트, 행 최대 65535바이트)
  strings: { VARCHAR: { max: 16383 }, CHAR: { max: 255 }, VARBINARY: { max: 65535 }, BINARY: { max: 255 } },
  tooLongToText: true,
  integerDisplayWidth: true,
  decimal: { types: typeWords('DECIMAL NUMERIC'), p: 65, s: 30, sWithinP: true },
  onUpdatePrecisionStrict: true,
  defaultTimeStrict: { types: typeWords('DATETIME TIMESTAMP') },
  // MySQL 8.0.13 이상: TEXT·BLOB·JSON 기본값은 괄호 식만
  lobNoLiteralDefault: MYSQL_LOB,
  rowSize: { max: 65535, bytes: mysqlRowBytes },
};

export const mysql: Dialect = {
  id: 'mysql',
  label: 'MySQL',
  ddlGrammar: { family: 'mysql', backslashEscapes: true, hidesFkIndexes: true, keepsPrimaryKeyName: false, quotedTypeNames: false },
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
    const autoKey = autoIncrementKey(table);
    if (autoKey) lines.push(`  ${autoKey.unique ? 'UNIQUE ' : ''}KEY ${q(indexName(table, autoKey))} (${indexKeys(table, autoKey, q)})`);
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

  features: {
    // DB 객체: 뷰·함수·프로시저·트리거·이벤트 (DEFINER는 저장하지 않는다)
    objects: dbObjectsModule({
      kinds: ['view', 'function', 'procedure', 'trigger', 'event'],
      quote: q,
      drop: {
        view: (o, q) => `DROP VIEW IF EXISTS ${q(o.name)}`,
        function: (o, q) => `DROP FUNCTION IF EXISTS ${q(o.name)}`,
        procedure: (o, q) => `DROP PROCEDURE IF EXISTS ${q(o.name)}`,
        trigger: (o, q) => `DROP TRIGGER IF EXISTS ${q(o.name)}`,
        event: (o, q) => `DROP EVENT IF EXISTS ${q(o.name)}`,
      },
      templates: {
        view: (n, t) => `CREATE VIEW ${q(n)} AS
SELECT *
FROM ${q(t)}`,
        function: (n) => `CREATE FUNCTION ${q(n)}(p INT)
RETURNS INT
DETERMINISTIC
BEGIN
  RETURN p;
END`,
        procedure: (n) => `CREATE PROCEDURE ${q(n)}()
BEGIN
  SELECT 1;
END`,
        trigger: (n, t) => `CREATE TRIGGER ${q(n)}
BEFORE INSERT ON ${q(t)}
FOR EACH ROW
BEGIN
  -- SET NEW.column = ...;
END`,
        event: (n, t) => `CREATE EVENT ${q(n)}
ON SCHEDULE EVERY 1 DAY
DO
  DELETE FROM ${q(t)} WHERE created_at < NOW() - INTERVAL 30 DAY`,
      },
    }),
    enum: enumInColumn,
    // MySQL 8.0.16+: CHECK 삭제는 DROP CHECK
    check: standardCheck(q, { drop: (table, check) => [`ALTER TABLE ${q(table.name)} DROP CHECK ${q(checkName(table, check))}`] }),
    expressionIndex: {
      example: (col) => `(lower(\`${col}\`))`,
      hint: '예) (lower(`email`)) — MySQL 8.0.13 이상, 식마다 괄호를 한 번 더 감쌉니다',
      warn: (e) => (/::|\bto_tsvector\b|\bto_tsquery\b|\bjsonb_/i.test(e) ? `식에 PostgreSQL 전용 문법이 있어 MySQL에서는 실패할 수 있습니다: ${e}` : undefined),
    },
    indexMethods: { methods: ['fulltext', 'spatial'], label: (m) => m.toUpperCase() },
    generated: { virtual: true, stored: true },
    onUpdateTimestamp: { types: /^(TIMESTAMP|DATETIME)/i },
    fkOnUpdate: { actions: ['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT'] },
  },
  traits: { fkAutoIndex: true, fkNeedsIndex: true, noJsonColumnIndex: true, varcharLengthIsTypeError: true },
  types: mysqlTypes,
  connection: { port: 3306, databaseLabel: '스키마(DB)', databasePlaceholder: 'shop', transactional: false },
  safety: { countUpTo: limitCount, lengthFn: 'CHAR_LENGTH', notNumeric: (col, integer) => `${col} IS NOT NULL AND ${col} NOT REGEXP '${numericRegex(integer)}'` },
  createIndex(table: Table, index) {
    // MySQL은 식마다 괄호를 한 번 더 감싸야 한다: lower(email) → (lower(email))
    const keys = index.expression?.trim() ? mysqlKeyParts(index.expression) : indexKeys(table, index, q);
    // FULLTEXT·SPATIAL 인덱스는 종류를 앞에 붙인다 (UNIQUE와 함께 쓸 수 없다)
    const method = index.method?.trim().toLowerCase();
    const kind = method === 'fulltext' || method === 'spatial' ? `${method.toUpperCase()} ` : index.unique ? 'UNIQUE ' : '';
    return [`CREATE ${kind}INDEX ${q(indexName(table, index))} ON ${q(table.name)} (${keys})`];
  },
  inlineIndexIds: (table) => {
    const key = autoIncrementKey(table);
    return key ? [key.id] : [];
  },
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
