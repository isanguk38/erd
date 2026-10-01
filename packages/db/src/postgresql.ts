import pg from 'pg';
import { createColumn, createIndex, createRelation, createTable, emptySchema, type Column, type ReferentialAction, type Schema, type Table } from '@erd/core';
import type { ConnectionConfig, Connector, ExecuteResult, IntrospectOptions, IntrospectResult, StatementResult } from './types';

/** pg.Client, PGlite 등 query(sql, params)를 가진 무엇이든 */
export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

const ACTIONS: Record<string, ReferentialAction> = { a: 'NO ACTION', r: 'RESTRICT', c: 'CASCADE', n: 'SET NULL', d: 'SET DEFAULT' };

const TYPE_NAMES: Record<string, string> = {
  'character varying': 'VARCHAR',
  character: 'CHAR',
  'timestamp without time zone': 'TIMESTAMP',
  'timestamp with time zone': 'TIMESTAMPTZ',
  'time without time zone': 'TIME',
  'time with time zone': 'TIMETZ',
  integer: 'INT',
  'bit varying': 'VARBIT',
};

/** format_type() 결과를 타입과 길이로 나눈다. 예: character varying(100) → VARCHAR, 100 */
export function parsePgType(formatted: string): { type: string; length: string } {
  let array = '';
  let t = formatted.trim();
  while (t.endsWith('[]')) {
    array += '[]';
    t = t.slice(0, -2);
  }
  let length = '';
  const m = t.match(/^(.*?)\(([^)]*)\)(.*)$/);
  if (m) {
    length = m[2].replace(/\s+/g, '');
    t = `${m[1]}${m[3]}`.replace(/\s+/g, ' ').trim();
  }
  const type = (TYPE_NAMES[t] ?? t).toUpperCase() + array;
  return { type, length };
}

/** 'READY'::character varying → 'READY' */
export function cleanPgDefault(value: string | null): string | null {
  if (value === null) return null;
  let v = value.trim();
  // 형 변환 꼬리 제거 (여러 번 붙을 수 있음)
  for (let i = 0; i < 3; i++) v = v.replace(/::[a-z_ ]+(\(\d+(,\d+)?\))?(\[\])?$/i, '');
  if (/^\((.*)\)$/.test(v) && !/^\(.*\)\s*\(/.test(v)) {
    const inner = v.slice(1, -1);
    if (/^-?\d+(\.\d+)?$/.test(inner)) v = inner;
  }
  return /^null$/i.test(v) ? null : v;
}

const SQL_TABLES = `
  SELECT c.relname AS table_name, obj_description(c.oid, 'pg_class') AS comment
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') AND NOT c.relispartition
  ORDER BY c.relname`;

const SQL_COLUMNS = `
  SELECT c.relname AS table_name, a.attname AS column_name,
         format_type(a.atttypid, a.atttypmod) AS data_type,
         a.attnotnull AS not_null, pg_get_expr(d.adbin, d.adrelid) AS default_value,
         a.attidentity AS identity, col_description(c.oid, a.attnum) AS comment
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') AND NOT c.relispartition AND a.attnum > 0 AND NOT a.attisdropped
  ORDER BY c.relname, a.attnum`;

const SQL_CONSTRAINTS = `
  SELECT con.conname AS name, con.contype AS type, c.relname AS table_name, a.attname AS column_name, k.ord,
         fc.relname AS ref_table, fa.attname AS ref_column, fn.nspname AS ref_schema,
         con.confdeltype AS on_delete, con.confupdtype AS on_update
  FROM pg_constraint con
  JOIN pg_class c ON c.oid = con.conrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
  LEFT JOIN pg_class fc ON fc.oid = con.confrelid
  LEFT JOIN pg_namespace fn ON fn.oid = fc.relnamespace
  LEFT JOIN pg_attribute fa ON fa.attrelid = con.confrelid AND fa.attnum = con.confkey[k.ord]
  WHERE n.nspname = $1 AND con.contype IN ('p', 'f', 'u')
  ORDER BY c.relname, con.conname, k.ord`;

const SQL_INDEXES = `
  SELECT t.relname AS table_name, i.relname AS index_name, ix.indisunique AS is_unique, a.attname AS column_name, k.ord
  FROM pg_index ix
  JOIN pg_class i ON i.oid = ix.indexrelid
  JOIN pg_class t ON t.oid = ix.indrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  CROSS JOIN LATERAL unnest(ix.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
  LEFT JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
  WHERE n.nspname = $1 AND t.relkind IN ('r', 'p') AND NOT ix.indisprimary
    AND NOT EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid = ix.indexrelid)
  ORDER BY t.relname, i.relname, k.ord`;

interface ColumnRow { table_name: string; column_name: string; data_type: string; not_null: boolean; default_value: string | null; identity: string; comment: string | null }
interface ConstraintRow { name: string; type: 'p' | 'f' | 'u'; table_name: string; column_name: string; ref_table: string | null; ref_column: string | null; ref_schema: string | null; on_delete: string; on_update: string }
interface IndexRow { table_name: string; index_name: string; is_unique: boolean; column_name: string | null }

/** 카탈로그(pg_catalog)를 읽어 스키마 모델을 만든다. 데이터 행은 읽지 않는다. */
export async function introspectPostgres(db: Queryable, schemaName: string, options: IntrospectOptions = {}): Promise<{ schema: Schema; warnings: string[] }> {
  const commentAs = options.commentAs ?? 'logicalName';
  const schema = emptySchema();
  const warnings: string[] = [];
  const tables = new Map<string, Table>();
  const setComment = (item: { comment: string; logicalName: string }, value: string | null) => {
    if (!value) return;
    if (commentAs === 'logicalName') item.logicalName = value;
    else item.comment = value;
  };

  for (const row of (await db.query<{ table_name: string; comment: string | null }>(SQL_TABLES, [schemaName])).rows) {
    const table = createTable({ name: row.table_name });
    setComment(table, row.comment);
    tables.set(row.table_name, table);
    schema.tables.push(table);
  }

  for (const row of (await db.query<ColumnRow>(SQL_COLUMNS, [schemaName])).rows) {
    const table = tables.get(row.table_name);
    if (!table) continue;
    const { type, length } = parsePgType(row.data_type);
    const column: Column = createColumn({ name: row.column_name, type, length, nullable: !row.not_null, defaultValue: cleanPgDefault(row.default_value) });
    if (row.identity === 'a' || row.identity === 'd') column.autoIncrement = true;
    if (column.defaultValue && /^nextval\(/i.test(column.defaultValue)) {
      // serial 컬럼
      column.autoIncrement = true;
      column.defaultValue = null;
    }
    setComment(column, row.comment);
    table.columns.push(column);
  }

  const constraints = new Map<string, { row: ConstraintRow; columns: string[]; refColumns: string[] }>();
  for (const row of (await db.query<ConstraintRow>(SQL_CONSTRAINTS, [schemaName])).rows) {
    const k = `${row.table_name}\u0000${row.name}`;
    const entry = constraints.get(k) ?? { row, columns: [], refColumns: [] };
    entry.columns.push(row.column_name);
    if (row.ref_column) entry.refColumns.push(row.ref_column);
    constraints.set(k, entry);
  }

  const columnId = (table: Table, name: string) => table.columns.find((c) => c.name === name)?.id;

  for (const { row, columns, refColumns } of constraints.values()) {
    const table = tables.get(row.table_name);
    if (!table) continue;
    if (row.type === 'p') {
      table.primaryKeyName = row.name;
      for (const c of table.columns) if (columns.includes(c.name)) { c.primaryKey = true; c.nullable = false; }
    } else if (row.type === 'u') {
      const ids = columns.map((n) => columnId(table, n)).filter((x): x is string => !!x);
      table.indexes.push(createIndex({ name: row.name, columnIds: ids, unique: true, isConstraint: true }));
    } else if (row.type === 'f') {
      if (row.ref_schema !== schemaName) {
        warnings.push(`${table.name}.${row.name}: 다른 스키마(${row.ref_schema})를 참조하는 외래키는 가져오지 않습니다`);
        continue;
      }
      const parent = row.ref_table ? tables.get(row.ref_table) : undefined;
      if (!parent) continue;
      const fromIds = columns.map((n) => columnId(table, n));
      const toIds = refColumns.map((n) => columnId(parent, n));
      if (fromIds.some((x) => !x) || toIds.some((x) => !x)) continue;
      schema.relations.push(
        createRelation({
          name: row.name,
          fromTableId: table.id,
          fromColumnIds: fromIds as string[],
          toTableId: parent.id,
          toColumnIds: toIds as string[],
          onDelete: ACTIONS[row.on_delete] ?? 'NO ACTION',
          onUpdate: ACTIONS[row.on_update] ?? 'NO ACTION',
        }),
      );
    }
  }

  const indexes = new Map<string, { table: string; unique: boolean; columns: (string | null)[] }>();
  for (const row of (await db.query<IndexRow>(SQL_INDEXES, [schemaName])).rows) {
    const k = `${row.table_name}\u0000${row.index_name}`;
    const entry = indexes.get(k) ?? { table: row.table_name, unique: row.is_unique, columns: [] };
    entry.columns.push(row.column_name);
    indexes.set(k, entry);
  }
  for (const [k, entry] of indexes) {
    const table = tables.get(entry.table);
    if (!table) continue;
    const name = k.split('\u0000')[1];
    if (entry.columns.some((c) => !c)) {
      warnings.push(`${table.name}.${name}: 식(expression) 인덱스는 가져오지 않습니다`);
      continue;
    }
    const ids = entry.columns.map((n) => columnId(table, n!)).filter((x): x is string => !!x);
    table.indexes.push(createIndex({ name, columnIds: ids, unique: entry.unique }));
  }

  // 1:1 추정: FK 컬럼이 그대로 UNIQUE/PK이면 1:1
  for (const r of schema.relations) {
    const table = schema.tables.find((t) => t.id === r.fromTableId)!;
    const pk = table.columns.filter((c) => c.primaryKey).map((c) => c.id);
    const same = (ids: string[]) => ids.length === r.fromColumnIds.length && ids.every((id) => r.fromColumnIds.includes(id));
    if (same(pk) || table.indexes.some((i) => i.unique && same(i.columnIds))) r.cardinality = '1:1';
  }

  return { schema, warnings };
}

/** 문장을 하나의 트랜잭션으로 실행한다. 하나라도 실패하면 모두 되돌린다. */
export async function executePostgres(db: Queryable, statements: string[]): Promise<ExecuteResult> {
  const results: StatementResult[] = [];
  await db.query('BEGIN');
  let failed = false;
  for (const sql of statements) {
    if (failed) {
      results.push({ sql, ok: false, skipped: true, ms: 0 });
      continue;
    }
    const start = Date.now();
    try {
      await db.query(sql);
      results.push({ sql, ok: true, ms: Date.now() - start });
    } catch (e) {
      failed = true;
      results.push({ sql, ok: false, error: e instanceof Error ? e.message : String(e), ms: Date.now() - start });
    }
  }
  await db.query(failed ? 'ROLLBACK' : 'COMMIT');
  return { results, ok: !failed, rolledBack: failed, appliedCount: failed ? 0 : statements.length };
}

async function withClient<T>(config: ConnectionConfig, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 60_000,
    application_name: 'erd',
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

export const postgresConnector: Connector = {
  dialect: 'postgresql',
  test: (config) =>
    withClient(config, async (client) => {
      const { rows } = await client.query<{ v: string }>('SELECT version() AS v');
      return { serverVersion: rows[0].v.split(',')[0] };
    }),
  introspect: (config, options) =>
    withClient(config, async (client) => {
      const { rows } = await client.query<{ v: string }>("SELECT current_setting('server_version') AS v");
      const result = await introspectPostgres(client, config.schema || 'public', options);
      return { ...result, serverVersion: `PostgreSQL ${rows[0].v}` } satisfies IntrospectResult;
    }),
  execute: (config, statements) =>
    withClient(config, async (client) => {
      if (config.schema && config.schema !== 'public') await client.query(`SET search_path TO "${config.schema.replace(/"/g, '""')}"`);
      return executePostgres(client, statements);
    }),
};
