import mysql from 'mysql2/promise';
import { createColumn, createIndex, createRelation, createTable, emptySchema, type Column, type ReferentialAction, type Schema, type Table } from '@erd/core';
import { stabilizeIds } from './stableIds';
import { explainConnectionError, guardErrors } from './errors';
import type { ConnectionConfig, Connector, ExecuteResult, IntrospectOptions, StatementResult } from './types';

export interface ColumnRow {
  TABLE_NAME: string;
  COLUMN_NAME: string;
  DATA_TYPE: string;
  COLUMN_TYPE: string;
  IS_NULLABLE: 'YES' | 'NO';
  COLUMN_DEFAULT: string | null;
  EXTRA: string;
  COLUMN_COMMENT: string;
}

const INTEGER = new Set(['tinyint', 'smallint', 'mediumint', 'int', 'integer', 'bigint']);
const NUMERIC = new Set([...INTEGER, 'decimal', 'numeric', 'float', 'double', 'real', 'bit', 'year']);

/** information_schema.COLUMNS 한 행을 컬럼 모델로 바꾼다 (MySQL 5.7/8, MariaDB 차이 흡수). */
export function mysqlColumnFromRow(row: ColumnRow): Column {
  const dataType = row.DATA_TYPE.toLowerCase();
  const columnType = row.COLUMN_TYPE.toLowerCase();
  const paren = row.COLUMN_TYPE.match(/\((.*)\)/);
  let length = paren ? paren[1].replace(/\s+(?=([^']*'[^']*')*[^']*$)/g, '') : '';
  let type = dataType.toUpperCase();
  const modifiers = [/\bunsigned\b/.test(columnType) ? 'UNSIGNED' : '', /\bzerofill\b/.test(columnType) ? 'ZEROFILL' : ''].filter(Boolean);

  if (INTEGER.has(dataType)) {
    if (dataType === 'tinyint' && length === '1' && !modifiers.length) type = 'BOOLEAN';
    length = ''; // 표시 폭은 의미 없음
  }
  if (type === 'INTEGER') type = 'INT';

  const extra = row.EXTRA.toLowerCase();
  let defaultValue: string | null = row.COLUMN_DEFAULT;
  if (defaultValue !== null) {
    if (/^null$/i.test(defaultValue)) defaultValue = null;
    else if (extra.includes('default_generated')) {
      // MySQL 8: 식 기본값 (CURRENT_TIMESTAMP 등)
    } else if (defaultValue.startsWith("'")) {
      // MariaDB는 이미 따옴표가 붙어 나온다
    } else if (/^current_timestamp(\(\d*\))?$/i.test(defaultValue)) {
      defaultValue = defaultValue.toUpperCase();
    } else if (NUMERIC.has(dataType) && /^-?\d+(\.\d+)?$/.test(defaultValue)) {
      // 숫자는 그대로
    } else if (dataType === 'bit' && /^b'[01]+'$/.test(defaultValue)) {
      // 비트 리터럴은 그대로
    } else {
      defaultValue = `'${defaultValue.replace(/'/g, "''")}'`;
    }
  }

  return createColumn({
    name: row.COLUMN_NAME,
    type: [type, ...modifiers].join(' '),
    length,
    nullable: row.IS_NULLABLE === 'YES',
    autoIncrement: extra.includes('auto_increment'),
    defaultValue,
    logicalName: '',
    comment: '',
  });
}

const ACTION: Record<string, ReferentialAction> = {
  'NO ACTION': 'NO ACTION',
  RESTRICT: 'RESTRICT',
  CASCADE: 'CASCADE',
  'SET NULL': 'SET NULL',
  'SET DEFAULT': 'SET DEFAULT',
};

type Rows = Record<string, any>[];

/** information_schema를 읽어 스키마 모델을 만든다. 데이터 행은 읽지 않는다. */
export async function introspectMysql(query: (sql: string, params: unknown[]) => Promise<Rows>, database: string, options: IntrospectOptions = {}) {
  const commentAs = options.commentAs ?? 'logicalName';
  const schema: Schema = emptySchema();
  const warnings: string[] = [];
  const tables = new Map<string, Table>();
  const setComment = (item: { comment: string; logicalName: string }, value: string | null | undefined) => {
    if (!value) return;
    if (commentAs === 'logicalName') item.logicalName = value;
    else item.comment = value;
  };

  for (const row of await query(
    `SELECT TABLE_NAME, TABLE_COMMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`,
    [database],
  )) {
    const table = createTable({ name: row.TABLE_NAME });
    setComment(table, row.TABLE_COMMENT);
    tables.set(row.TABLE_NAME, table);
    schema.tables.push(table);
  }

  for (const row of await query(
    `SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA, COLUMN_COMMENT
     FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION`,
    [database],
  )) {
    const table = tables.get(row.TABLE_NAME);
    if (!table) continue;
    const column = mysqlColumnFromRow(row as ColumnRow);
    if (/\b(virtual|stored) generated\b/i.test(row.EXTRA)) warnings.push(`${table.name}.${column.name}: 계산 컬럼의 식은 가져오지 않습니다`);
    setComment(column, row.COLUMN_COMMENT);
    table.columns.push(column);
  }

  const fkRows = await query(
    `SELECT k.CONSTRAINT_NAME, k.TABLE_NAME, k.COLUMN_NAME, k.REFERENCED_TABLE_SCHEMA, k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME,
            r.DELETE_RULE, r.UPDATE_RULE
     FROM information_schema.KEY_COLUMN_USAGE k
     JOIN information_schema.REFERENTIAL_CONSTRAINTS r
       ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.TABLE_NAME = k.TABLE_NAME
     WHERE k.TABLE_SCHEMA = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL
     ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
    [database],
  );
  const fks = new Map<string, { table: string; name: string; refSchema: string; refTable: string; columns: string[]; refColumns: string[]; onDelete: string; onUpdate: string }>();
  for (const row of fkRows) {
    const k = `${row.TABLE_NAME}\u0000${row.CONSTRAINT_NAME}`;
    const fk = fks.get(k) ?? {
      table: row.TABLE_NAME, name: row.CONSTRAINT_NAME, refSchema: row.REFERENCED_TABLE_SCHEMA, refTable: row.REFERENCED_TABLE_NAME,
      columns: [] as string[], refColumns: [] as string[], onDelete: row.DELETE_RULE, onUpdate: row.UPDATE_RULE,
    };
    fk.columns.push(row.COLUMN_NAME);
    fk.refColumns.push(row.REFERENCED_COLUMN_NAME);
    fks.set(k, fk);
  }

  const indexRows = await query(
    // SELECT *: EXPRESSION(식 인덱스) 열은 MySQL 8.0.13부터 있다 (MariaDB·이전 버전에는 없음)
    `SELECT * FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
    [database],
  );
  const indexes = new Map<string, { table: string; name: string; unique: boolean; columns: (string | null)[]; expressions: (string | null)[] }>();
  for (const row of indexRows) {
    const k = `${row.TABLE_NAME}\u0000${row.INDEX_NAME}`;
    const index = indexes.get(k) ?? { table: row.TABLE_NAME, name: row.INDEX_NAME, unique: Number(row.NON_UNIQUE) === 0, columns: [] as (string | null)[], expressions: [] as (string | null)[] };
    index.columns.push(row.COLUMN_NAME);
    index.expressions.push(row.EXPRESSION ?? null);
    indexes.set(k, index);
  }

  const columnId = (table: Table, name: string) => table.columns.find((c) => c.name === name)?.id;
  const fkList = [...fks.values()];

  for (const index of indexes.values()) {
    const table = tables.get(index.table);
    if (!table) continue;
    if (index.columns.some((c) => !c)) {
      if (index.expressions.some((e, i) => !index.columns[i] && !e)) {
        warnings.push(`${table.name}.${index.name}: 인덱스 정의를 읽지 못해 가져오지 않습니다`);
        continue;
      }
      // 식 인덱스: 키마다 컬럼은 `이름`, 식은 (식) — MySQL 문법 그대로
      const expression = index.columns.map((c, i) => (c ? `\`${c}\`` : `(${index.expressions[i]})`)).join(', ');
      table.indexes.push(createIndex({ name: index.name, columnIds: [], unique: index.unique, expression }));
      continue;
    }
    const names = index.columns as string[];
    if (index.name === 'PRIMARY') {
      for (const c of table.columns) if (names.includes(c.name)) { c.primaryKey = true; c.nullable = false; }
      continue;
    }
    // MySQL이 외래키를 위해 자동으로 만든 인덱스(이름이 FK와 같음)는 ERD에 그리지 않는다
    const autoFkIndex = !index.unique && fkList.some((fk) => fk.table === index.table && fk.name === index.name && fk.columns.join() === names.join());
    if (autoFkIndex) continue;
    const ids = names.map((n) => columnId(table, n)).filter((x): x is string => !!x);
    table.indexes.push(createIndex({ name: index.name, columnIds: ids, unique: index.unique }));
  }

  for (const fk of fkList) {
    const table = tables.get(fk.table);
    if (!table) continue;
    if (fk.refSchema !== database) {
      warnings.push(`${table.name}.${fk.name}: 다른 DB(${fk.refSchema})를 참조하는 외래키는 가져오지 않습니다`);
      continue;
    }
    const parent = tables.get(fk.refTable);
    if (!parent) continue;
    const fromIds = fk.columns.map((n) => columnId(table, n));
    const toIds = fk.refColumns.map((n) => columnId(parent, n));
    if (fromIds.some((x) => !x) || toIds.some((x) => !x)) continue;
    const pk = table.columns.filter((c) => c.primaryKey).map((c) => c.name);
    const oneToOne =
      (pk.length === fk.columns.length && pk.every((n) => fk.columns.includes(n))) ||
      table.indexes.some((i) => i.unique && i.columnIds.length === fromIds.length && i.columnIds.every((id) => fromIds.includes(id)));
    schema.relations.push(
      createRelation({
        name: fk.name,
        fromTableId: table.id,
        fromColumnIds: fromIds as string[],
        toTableId: parent.id,
        toColumnIds: toIds as string[],
        cardinality: oneToOne ? '1:1' : '1:N',
        onDelete: ACTION[fk.onDelete] ?? 'NO ACTION',
        onUpdate: ACTION[fk.onUpdate] ?? 'NO ACTION',
      }),
    );
  }

  return { schema: stabilizeIds(schema), warnings };
}

async function withConnection<T>(config: ConnectionConfig, fn: (conn: mysql.Connection) => Promise<T>): Promise<T> {
  const conn = await mysql.createConnection({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
    connectTimeout: 10_000,
    multipleStatements: false,
    charset: 'utf8mb4',
  }).catch((e) => { throw explainConnectionError(e); });
  guardErrors(conn);
  try {
    return await fn(conn);
  } catch (e) {
    throw explainConnectionError(e);
  } finally {
    await conn.end().catch(() => {});
  }
}

/** MySQL과 MariaDB는 같은 드라이버·같은 information_schema를 쓴다 */
function makeConnector(dialect: 'mysql' | 'mariadb'): Connector {
  const label = (v: string) => (/mariadb/i.test(v) ? `MariaDB ${v.replace(/-MariaDB.*$/i, '')}` : `MySQL ${v}`);
  return {
  dialect,
  test: (config) =>
    withConnection(config, async (conn) => {
      const [rows] = await conn.query('SELECT VERSION() AS v');
      return { serverVersion: label((rows as Rows)[0].v) };
    }),
  introspect: (config, options) =>
    withConnection(config, async (conn) => {
      const [rows] = await conn.query('SELECT VERSION() AS v');
      const run = async (sql: string, params: unknown[]) => (await conn.query(sql, params))[0] as Rows;
      const result = await introspectMysql(run, config.database, options);
      return { ...result, serverVersion: label((rows as Rows)[0].v) };
    }),
  execute: (config, statements) =>
    withConnection(config, async (conn) => {
      // MySQL은 DDL이 바로 커밋되므로 트랜잭션으로 묶을 수 없다. 실패하면 거기서 멈춘다.
      const results: StatementResult[] = [];
      let failed = false;
      for (const sql of statements) {
        if (failed) {
          results.push({ sql, ok: false, skipped: true, ms: 0 });
          continue;
        }
        const start = Date.now();
        try {
          await conn.query(sql);
          results.push({ sql, ok: true, ms: Date.now() - start });
        } catch (e) {
          failed = true;
          results.push({ sql, ok: false, error: e instanceof Error ? e.message : String(e), ms: Date.now() - start });
        }
      }
      const appliedCount = results.filter((r) => r.ok).length;
      return { results, ok: !failed, rolledBack: false, appliedCount } satisfies ExecuteResult;
    }),
};
}

export const mysqlConnector = makeConnector('mysql');
export const mariadbConnector = makeConnector('mariadb');
