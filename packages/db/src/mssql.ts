import sql from 'mssql';
import { createCheck, createColumn, createIndex, createRelation, createTable, emptySchema, type ReferentialAction, type Schema, type Table } from '@erd/core';
import { stabilizeIds } from './stableIds';
import { explainConnectionError, guardErrors } from './errors';
import { CHECK_TIMEOUT_MS, countOf, runSafetyChecks } from './safety';
import type { ConnectionConfig, Connector, ExecuteResult, IntrospectOptions, IntrospectResult, StatementResult } from './types';

// SQL Server 2016 이상 / Azure SQL. 스키마는 기본 dbo.

type Row = Record<string, any>;
export type MssqlQuery = (text: string, params: Record<string, string>) => Promise<Row[]>;

const WITH_LENGTH = new Set(['varchar', 'nvarchar', 'char', 'nchar', 'varbinary', 'binary']);

/** sys.columns 한 행 → 타입·길이 */
export function mssqlType(row: Row): { type: string; length: string } {
  const t = String(row.type_name).toLowerCase();
  const max = Number(row.max_length);
  if (WITH_LENGTH.has(t)) {
    if (max === -1) return { type: t.toUpperCase(), length: 'MAX' };
    // nvarchar·nchar는 바이트 수라 글자 수는 절반
    return { type: t.toUpperCase(), length: String(t.startsWith('n') ? max / 2 : max) };
  }
  if (t === 'decimal' || t === 'numeric') return { type: 'DECIMAL', length: `${row.precision},${row.scale}` };
  return { type: t.toUpperCase(), length: '' };
}

/** 기본값 정의 ((0)), ('A'), (getdate()) → 0, 'A', getdate() */
export function mssqlDefault(def: unknown): string | null {
  if (def === null || def === undefined) return null;
  let v = String(def).trim();
  while (v.startsWith('(') && v.endsWith(')') && balanced(v.slice(1, -1))) v = v.slice(1, -1).trim();
  if (/^N'/.test(v)) v = v.slice(1);
  return v || null;
}

function balanced(s: string): boolean {
  let depth = 0;
  let inStr = false;
  for (const ch of s) {
    if (ch === "'") inStr = !inStr;
    if (inStr) continue;
    if (ch === '(') depth++;
    if (ch === ')' && --depth < 0) return false;
  }
  return depth === 0;
}

const ACTION: Record<string, ReferentialAction> = { NO_ACTION: 'NO ACTION', CASCADE: 'CASCADE', SET_NULL: 'SET NULL', SET_DEFAULT: 'SET DEFAULT' };

export async function introspectMssql(query: MssqlQuery, schemaName: string, options: IntrospectOptions = {}): Promise<{ schema: Schema; warnings: string[] }> {
  const commentAs = options.commentAs ?? 'logicalName';
  const schema = emptySchema();
  const warnings: string[] = [];
  const tables = new Map<string, Table>();
  const setComment = (item: { comment: string; logicalName: string }, value: unknown) => {
    if (!value) return;
    if (commentAs === 'logicalName') item.logicalName = String(value);
    else item.comment = String(value);
  };
  const p = { schema: schemaName };

  for (const row of await query(
    `SELECT t.name, CAST(ep.value AS NVARCHAR(4000)) AS comment
     FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id
     LEFT JOIN sys.extended_properties ep ON ep.class = 1 AND ep.major_id = t.object_id AND ep.minor_id = 0 AND ep.name = 'MS_Description'
     WHERE s.name = @schema AND t.is_ms_shipped = 0 ORDER BY t.name`,
    p,
  )) {
    const table = createTable({ name: row.name });
    setComment(table, row.comment);
    tables.set(row.name, table);
    schema.tables.push(table);
  }

  for (const row of await query(
    `SELECT t.name AS table_name, c.name, ty.name AS type_name, c.max_length, c.precision, c.scale, c.is_nullable, c.is_identity, c.is_computed,
            dc.definition AS default_def, CAST(ep.value AS NVARCHAR(4000)) AS comment, cc.definition AS computed_def, cc.is_persisted
     FROM sys.columns c
     LEFT JOIN sys.computed_columns cc ON cc.object_id = c.object_id AND cc.column_id = c.column_id
     JOIN sys.tables t ON t.object_id = c.object_id JOIN sys.schemas s ON s.schema_id = t.schema_id
     JOIN sys.types ty ON ty.user_type_id = c.user_type_id
     LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id
     LEFT JOIN sys.extended_properties ep ON ep.class = 1 AND ep.major_id = c.object_id AND ep.minor_id = c.column_id AND ep.name = 'MS_Description'
     WHERE s.name = @schema ORDER BY t.name, c.column_id`,
    p,
  )) {
    const table = tables.get(row.table_name);
    if (!table) continue;
    const { type, length } = mssqlType(row);
    const column = createColumn({
      name: row.name,
      type,
      length,
      nullable: Boolean(row.is_nullable),
      autoIncrement: Boolean(row.is_identity),
      defaultValue: mssqlDefault(row.default_def),
      logicalName: '',
      comment: '',
    });
    // 계산 컬럼: 식은 바깥 괄호가 붙어 나온다 → 떼고 담는다
    if (row.is_computed && row.computed_def) {
      const def = String(row.computed_def).trim();
      column.generated = { expression: def.startsWith('(') && def.endsWith(')') ? def.slice(1, -1) : def, stored: Boolean(row.is_persisted) };
      column.defaultValue = null;
    }
    setComment(column, row.comment);
    table.columns.push(column);
  }

  // CHECK 제약: definition은 ([qty]>=(0)) 처럼 바깥 괄호가 붙어 나온다
  for (const row of await query(
    `SELECT t.name AS table_name, k.name, k.definition
     FROM sys.check_constraints k
     JOIN sys.tables t ON t.object_id = k.parent_object_id JOIN sys.schemas s ON s.schema_id = t.schema_id
     WHERE s.name = @schema ORDER BY t.name, k.name`,
    p,
  )) {
    const table = tables.get(row.table_name);
    const def = String(row.definition ?? '').trim();
    if (!table || !def) continue;
    table.checks = [...(table.checks ?? []), createCheck({ name: row.name, expression: def.startsWith('(') && def.endsWith(')') ? def.slice(1, -1) : def })];
  }

  const columnId = (table: Table, name: string) => table.columns.find((c) => c.name === name)?.id;

  // 인덱스 (기본키·UNIQUE 제약조건 포함)
  const indexes = new Map<string, { table: string; name: string; pk: boolean; unique: boolean; constraint: boolean; where: string | null; columns: string[] }>();
  for (const row of await query(
    `SELECT t.name AS table_name, i.name, i.is_primary_key, i.is_unique, i.is_unique_constraint, i.filter_definition, c.name AS column_name
     FROM sys.indexes i
     JOIN sys.tables t ON t.object_id = i.object_id JOIN sys.schemas s ON s.schema_id = t.schema_id
     JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0
     JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
     WHERE s.name = @schema AND i.type IN (1, 2) AND i.is_hypothetical = 0
     ORDER BY t.name, i.name, ic.key_ordinal`,
    p,
  )) {
    const k = `${row.table_name}\u0000${row.name}`;
    const e = indexes.get(k) ?? { table: row.table_name, name: row.name, pk: Boolean(row.is_primary_key), unique: Boolean(row.is_unique), constraint: Boolean(row.is_unique_constraint), where: row.filter_definition ?? null, columns: [] as string[] };
    e.columns.push(row.column_name);
    indexes.set(k, e);
  }
  for (const e of indexes.values()) {
    const table = tables.get(e.table);
    if (!table) continue;
    if (e.pk) {
      table.primaryKeyName = e.name;
      for (const c of table.columns) if (e.columns.includes(c.name)) { c.primaryKey = true; c.nullable = false; }
      continue;
    }
    const ids = e.columns.map((n) => columnId(table, n)).filter((x): x is string => !!x);
    // 필터 인덱스(WHERE 조건)는 조건까지 담는다
    table.indexes.push(createIndex({ name: e.name, columnIds: ids, unique: e.unique, isConstraint: e.constraint || undefined, ...(e.where ? { where: e.where } : {}) }));
  }

  // 외래키
  const fks = new Map<string, { table: string; name: string; refSchema: string; refTable: string; columns: string[]; refColumns: string[]; onDelete: string; onUpdate: string }>();
  for (const row of await query(
    `SELECT fk.name, t.name AS table_name, rs.name AS ref_schema, rt.name AS ref_table, pc.name AS column_name, rc.name AS ref_column,
            fk.delete_referential_action_desc AS on_delete, fk.update_referential_action_desc AS on_update
     FROM sys.foreign_keys fk
     JOIN sys.tables t ON t.object_id = fk.parent_object_id JOIN sys.schemas s ON s.schema_id = t.schema_id
     JOIN sys.tables rt ON rt.object_id = fk.referenced_object_id JOIN sys.schemas rs ON rs.schema_id = rt.schema_id
     JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
     JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
     JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
     WHERE s.name = @schema ORDER BY t.name, fk.name, fkc.constraint_column_id`,
    p,
  )) {
    const k = `${row.table_name}\u0000${row.name}`;
    const e = fks.get(k) ?? { table: row.table_name, name: row.name, refSchema: row.ref_schema, refTable: row.ref_table, columns: [] as string[], refColumns: [] as string[], onDelete: row.on_delete, onUpdate: row.on_update };
    e.columns.push(row.column_name);
    e.refColumns.push(row.ref_column);
    fks.set(k, e);
  }
  for (const fk of fks.values()) {
    const table = tables.get(fk.table);
    if (!table) continue;
    if (fk.refSchema !== schemaName) {
      warnings.push(`${table.name}.${fk.name}: 다른 스키마(${fk.refSchema})를 참조하는 외래키는 가져오지 않습니다`);
      continue;
    }
    const parent = tables.get(fk.refTable);
    if (!parent) continue;
    const fromIds = fk.columns.map((n) => columnId(table, n));
    const toIds = fk.refColumns.map((n) => columnId(parent, n));
    if (fromIds.some((x) => !x) || toIds.some((x) => !x)) continue;
    const pk = table.columns.filter((c) => c.primaryKey).map((c) => c.id);
    const same = (ids: string[]) => ids.length === fromIds.length && ids.every((id) => fromIds.includes(id));
    schema.relations.push(
      createRelation({
        name: fk.name,
        fromTableId: table.id,
        fromColumnIds: fromIds as string[],
        toTableId: parent.id,
        toColumnIds: toIds as string[],
        cardinality: same(pk) || table.indexes.some((i) => i.unique && same(i.columnIds)) ? '1:1' : '1:N',
        onDelete: ACTION[fk.onDelete] ?? 'NO ACTION',
        onUpdate: ACTION[fk.onUpdate] ?? 'NO ACTION',
      }),
    );
  }

  return { schema: stabilizeIds(schema), warnings };
}

async function withPool<T>(config: ConnectionConfig, fn: (pool: sql.ConnectionPool) => Promise<T>): Promise<T> {
  const created = new sql.ConnectionPool({
    server: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    connectionTimeout: 10_000,
    requestTimeout: 60_000,
    options: { encrypt: Boolean(config.ssl), trustServerCertificate: true },
  });
  guardErrors(created);
  const pool = await created.connect().catch((e) => { throw explainConnectionError(e); });
  try {
    return await fn(pool);
  } catch (e) {
    throw explainConnectionError(e);
  } finally {
    await pool.close().catch(() => {});
  }
}

const versionOf = async (pool: sql.ConnectionPool) =>
  `SQL Server ${(await pool.request().query<{ v: string }>("SELECT CAST(SERVERPROPERTY('ProductVersion') AS NVARCHAR(64)) AS v")).recordset[0].v}`;

export const mssqlConnector: Connector = {
  dialect: 'mssql',
  test: (config) => withPool(config, async (pool) => ({ serverVersion: await versionOf(pool) })),
  introspect: (config, options) =>
    withPool(config, async (pool) => {
      const run: MssqlQuery = async (text, params) => {
        const req = pool.request();
        for (const [k, v] of Object.entries(params)) req.input(k, sql.NVarChar, v);
        return (await req.query(text)).recordset as Row[];
      };
      const result = await introspectMssql(run, config.schema || 'dbo', options);
      return { ...result, serverVersion: await versionOf(pool) } satisfies IntrospectResult;
    }),
  // SQL Server는 DDL도 트랜잭션으로 묶을 수 있다: 하나라도 실패하면 모두 되돌린다
  execute: (config, statements) =>
    withPool(config, async (pool) => {
      const tx = new sql.Transaction(pool);
      await tx.begin();
      const results: StatementResult[] = [];
      let failed = false;
      for (const text of statements) {
        if (failed) {
          results.push({ sql: text, ok: false, skipped: true, ms: 0 });
          continue;
        }
        const start = Date.now();
        try {
          await new sql.Request(tx).batch(text);
          results.push({ sql: text, ok: true, ms: Date.now() - start });
        } catch (e) {
          failed = true;
          results.push({ sql: text, ok: false, error: e instanceof Error ? e.message : String(e), ms: Date.now() - start });
        }
      }
      if (failed) await tx.rollback().catch(() => {});
      else await tx.commit();
      return { results, ok: !failed, rolledBack: failed, appliedCount: failed ? 0 : statements.length } satisfies ExecuteResult;
    }),
  // SQL Server에는 읽기 전용 트랜잭션이 없어 트랜잭션으로 묶고 끝나면 항상 되돌린다 (검사는 SELECT뿐)
  check: (config, checks) =>
    withPool(config, async (pool) => {
      const tx = new sql.Transaction(pool);
      await tx.begin();
      try {
        return await runSafetyChecks('mssql', checks, async (text) => {
          const req = new sql.Request(tx);
          (req as unknown as { timeout: number }).timeout = CHECK_TIMEOUT_MS;
          return countOf((await req.query(text)).recordset as unknown[]);
        });
      } finally {
        await tx.rollback().catch(() => {});
      }
    }),
};
