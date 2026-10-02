import oracledb from 'oracledb';
import { createColumn, createIndex, createRelation, createTable, emptySchema, type ReferentialAction, type Schema, type Table } from '@erd/core';
import { stabilizeIds } from './stableIds';
import { explainConnectionError } from './errors';
import type { ConnectionConfig, Connector, ExecuteResult, IntrospectOptions, IntrospectResult, StatementResult } from './types';

// Oracle 12c 이상. 드라이버는 Thin 모드라 Oracle Client 설치가 필요 없다.
// 연결 정보: host, port(1521), database = 서비스 이름(예: FREEPDB1, ORCLPDB1), 스키마 = 사용자(기본).

type Row = Record<string, any>;
export type OracleQuery = (sql: string, binds: Record<string, string>) => Promise<Row[]>;

/** 따옴표 없이 만든 이름은 Oracle이 대문자로 저장한다 → ERD에서는 소문자로 (다시 내보내면 같은 이름) */
export function fromOracleName(name: string): string {
  return /^[A-Z][A-Z0-9_$#]*$/.test(name) ? name.toLowerCase() : name;
}

/** ALL_TAB_COLUMNS 한 행 → 타입·길이 */
export function oracleType(row: Row): { type: string; length: string } {
  const dt = String(row.DATA_TYPE).toUpperCase();
  if (dt === 'NUMBER') {
    const p = row.DATA_PRECISION === null || row.DATA_PRECISION === undefined ? null : Number(row.DATA_PRECISION);
    const s = row.DATA_SCALE === null || row.DATA_SCALE === undefined ? null : Number(row.DATA_SCALE);
    if (p === null) return { type: 'NUMBER', length: '' };
    if (!s) {
      // ERD에서 만든 정수 타입이 그대로 보이게 (다시 내보내면 같은 NUMBER(n))
      const named: Record<number, string> = { 19: 'BIGINT', 10: 'INT', 5: 'SMALLINT', 3: 'TINYINT', 1: 'BOOLEAN' };
      return named[p] ? { type: named[p], length: '' } : { type: 'NUMBER', length: String(p) };
    }
    return { type: 'NUMBER', length: `${p},${s}` };
  }
  if (/^(N?VARCHAR2|N?CHAR)$/.test(dt)) return { type: dt, length: String(row.CHAR_LENGTH ?? row.DATA_LENGTH) };
  if (dt === 'RAW') return { type: 'RAW', length: String(row.DATA_LENGTH) };
  if (dt.startsWith('TIMESTAMP')) return { type: /WITH TIME ZONE/.test(dt) ? 'TIMESTAMP WITH TIME ZONE' : 'TIMESTAMP', length: '' };
  return { type: dt, length: '' };
}

/** DATA_DEFAULT: 끝 공백·줄바꿈 제거, NULL은 없음으로 */
export function oracleDefault(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const v = String(value).trim();
  if (!v || /^null$/i.test(v)) return null;
  return v;
}

const RULE: Record<string, ReferentialAction> = { CASCADE: 'CASCADE', 'SET NULL': 'SET NULL', 'NO ACTION': 'NO ACTION' };

export async function introspectOracle(query: OracleQuery, owner: string, options: IntrospectOptions = {}): Promise<{ schema: Schema; warnings: string[] }> {
  const commentAs = options.commentAs ?? 'logicalName';
  const schema = emptySchema();
  const warnings: string[] = [];
  const tables = new Map<string, Table>();
  const setComment = (item: { comment: string; logicalName: string }, value: unknown) => {
    if (!value) return;
    if (commentAs === 'logicalName') item.logicalName = String(value);
    else item.comment = String(value);
  };

  for (const row of await query(
    `SELECT t.TABLE_NAME, c.COMMENTS FROM ALL_TABLES t
     LEFT JOIN ALL_TAB_COMMENTS c ON c.OWNER = t.OWNER AND c.TABLE_NAME = t.TABLE_NAME
     WHERE t.OWNER = :owner AND t.NESTED = 'NO' AND t.SECONDARY = 'N' AND t.TABLE_NAME NOT LIKE 'BIN$%'
     ORDER BY t.TABLE_NAME`,
    { owner },
  )) {
    const table = createTable({ name: fromOracleName(row.TABLE_NAME) });
    setComment(table, row.COMMENTS);
    tables.set(row.TABLE_NAME, table);
    schema.tables.push(table);
  }

  for (const row of await query(
    `SELECT c.TABLE_NAME, c.COLUMN_NAME, c.DATA_TYPE, c.DATA_LENGTH, c.CHAR_LENGTH, c.DATA_PRECISION, c.DATA_SCALE, c.NULLABLE,
            c.DATA_DEFAULT, c.IDENTITY_COLUMN, c.VIRTUAL_COLUMN, m.COMMENTS
     FROM ALL_TAB_COLS c
     LEFT JOIN ALL_COL_COMMENTS m ON m.OWNER = c.OWNER AND m.TABLE_NAME = c.TABLE_NAME AND m.COLUMN_NAME = c.COLUMN_NAME
     WHERE c.OWNER = :owner AND c.HIDDEN_COLUMN = 'NO'
     ORDER BY c.TABLE_NAME, c.COLUMN_ID`,
    { owner },
  )) {
    const table = tables.get(row.TABLE_NAME);
    if (!table) continue;
    const { type, length } = oracleType(row);
    const identity = row.IDENTITY_COLUMN === 'YES';
    const column = createColumn({
      name: fromOracleName(row.COLUMN_NAME),
      type,
      length,
      nullable: row.NULLABLE === 'Y',
      autoIncrement: identity,
      // IDENTITY 컬럼의 기본값은 내부 시퀀스라 가져오지 않는다
      defaultValue: identity ? null : oracleDefault(row.DATA_DEFAULT),
      logicalName: '',
      comment: '',
    });
    if (row.VIRTUAL_COLUMN === 'YES') warnings.push(`${table.name}.${column.name}: 가상 컬럼의 식은 가져오지 않습니다`);
    setComment(column, row.COMMENTS);
    table.columns.push(column);
  }

  const columnId = (table: Table, dbName: string) => table.columns.find((c) => c.name === fromOracleName(dbName))?.id;

  // 제약조건: 기본키(P), UNIQUE(U), 외래키(R)
  const cons = new Map<string, { name: string; type: string; table: string; rOwner: string | null; rName: string | null; deleteRule: string; columns: string[]; index: string | null }>();
  for (const row of await query(
    `SELECT c.CONSTRAINT_NAME, c.CONSTRAINT_TYPE, c.TABLE_NAME, c.R_OWNER, c.R_CONSTRAINT_NAME, c.DELETE_RULE, c.INDEX_NAME, cc.COLUMN_NAME
     FROM ALL_CONSTRAINTS c
     JOIN ALL_CONS_COLUMNS cc ON cc.OWNER = c.OWNER AND cc.CONSTRAINT_NAME = c.CONSTRAINT_NAME
     WHERE c.OWNER = :owner AND c.CONSTRAINT_TYPE IN ('P', 'U', 'R')
     ORDER BY c.TABLE_NAME, c.CONSTRAINT_NAME, cc.POSITION`,
    { owner },
  )) {
    const entry = cons.get(row.CONSTRAINT_NAME) ?? {
      name: row.CONSTRAINT_NAME, type: row.CONSTRAINT_TYPE, table: row.TABLE_NAME, rOwner: row.R_OWNER, rName: row.R_CONSTRAINT_NAME,
      deleteRule: row.DELETE_RULE, columns: [] as string[], index: row.INDEX_NAME ?? null,
    };
    entry.columns.push(row.COLUMN_NAME);
    cons.set(row.CONSTRAINT_NAME, entry);
  }
  const constraintIndexes = new Set([...cons.values()].map((c) => c.index ?? c.name));

  for (const c of cons.values()) {
    const table = tables.get(c.table);
    if (!table) continue;
    if (c.type === 'P') {
      table.primaryKeyName = fromOracleName(c.name);
      for (const col of table.columns) if (c.columns.map(fromOracleName).includes(col.name)) { col.primaryKey = true; col.nullable = false; }
    } else if (c.type === 'U') {
      const ids = c.columns.map((n) => columnId(table, n)).filter((x): x is string => !!x);
      table.indexes.push(createIndex({ name: fromOracleName(c.name), columnIds: ids, unique: true, isConstraint: true }));
    }
  }

  for (const row of await query(
    `SELECT i.INDEX_NAME, i.TABLE_NAME, i.UNIQUENESS, i.INDEX_TYPE, ic.COLUMN_NAME
     FROM ALL_INDEXES i
     JOIN ALL_IND_COLUMNS ic ON ic.INDEX_OWNER = i.OWNER AND ic.INDEX_NAME = i.INDEX_NAME
     WHERE i.OWNER = :owner AND i.INDEX_TYPE <> 'LOB'
     ORDER BY i.TABLE_NAME, i.INDEX_NAME, ic.COLUMN_POSITION`,
    { owner },
  ).then(groupIndexes)) {
    if (constraintIndexes.has(row.name)) continue; // 기본키·UNIQUE 제약조건이 만든 인덱스
    const table = tables.get(row.table);
    if (!table) continue;
    if (/FUNCTION/.test(row.indexType)) {
      warnings.push(`${table.name}.${fromOracleName(row.name)}: 함수 기반 인덱스는 가져오지 않습니다`);
      continue;
    }
    const ids = row.columns.map((n) => columnId(table, n)).filter((x): x is string => !!x);
    if (ids.length) table.indexes.push(createIndex({ name: fromOracleName(row.name), columnIds: ids, unique: row.unique }));
  }

  for (const c of cons.values()) {
    if (c.type !== 'R') continue;
    const table = tables.get(c.table);
    const ref = c.rName ? cons.get(c.rName) : undefined;
    if (!table) continue;
    if (!ref || c.rOwner !== owner) {
      warnings.push(`${table.name}.${fromOracleName(c.name)}: 다른 스키마를 참조하는 외래키는 가져오지 않습니다`);
      continue;
    }
    const parent = tables.get(ref.table);
    if (!parent) continue;
    const fromIds = c.columns.map((n) => columnId(table, n));
    const toIds = ref.columns.map((n) => columnId(parent, n));
    if (fromIds.some((x) => !x) || toIds.some((x) => !x)) continue;
    const pk = table.columns.filter((x) => x.primaryKey).map((x) => x.id);
    const same = (ids: string[]) => ids.length === fromIds.length && ids.every((id) => fromIds.includes(id));
    schema.relations.push(
      createRelation({
        name: fromOracleName(c.name),
        fromTableId: table.id,
        fromColumnIds: fromIds as string[],
        toTableId: parent.id,
        toColumnIds: toIds as string[],
        cardinality: same(pk) || table.indexes.some((i) => i.unique && same(i.columnIds)) ? '1:1' : '1:N',
        onDelete: RULE[c.deleteRule] ?? 'NO ACTION',
        onUpdate: 'NO ACTION',
      }),
    );
  }

  return { schema: stabilizeIds(schema), warnings };
}

function groupIndexes(rows: Row[]) {
  const map = new Map<string, { name: string; table: string; unique: boolean; indexType: string; columns: string[] }>();
  for (const r of rows) {
    const e = map.get(r.INDEX_NAME) ?? { name: r.INDEX_NAME, table: r.TABLE_NAME, unique: r.UNIQUENESS === 'UNIQUE', indexType: String(r.INDEX_TYPE ?? ''), columns: [] as string[] };
    e.columns.push(r.COLUMN_NAME);
    map.set(r.INDEX_NAME, e);
  }
  return [...map.values()];
}

async function withConnection<T>(config: ConnectionConfig, fn: (conn: oracledb.Connection) => Promise<T>): Promise<T> {
  const conn = await oracledb.getConnection({
    user: config.user,
    password: config.password,
    connectString: `${config.host}:${config.port}/${config.database}`,
    connectTimeout: 10,
  }).catch((e) => { throw explainConnectionError(e); });
  try {
    return await fn(conn);
  } catch (e) {
    throw explainConnectionError(e);
  } finally {
    await conn.close().catch(() => {});
  }
}

const ownerOf = (config: ConnectionConfig) => (config.schema || config.user).toUpperCase();

export const oracleConnector: Connector = {
  dialect: 'oracle',
  test: (config) => withConnection(config, async (conn) => ({ serverVersion: `Oracle ${conn.oracleServerVersionString}` })),
  introspect: (config, options) =>
    withConnection(config, async (conn) => {
      const run: OracleQuery = async (sql, binds) => ((await conn.execute(sql, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT, fetchTypeHandler: longAsString })).rows ?? []) as Row[];
      const result = await introspectOracle(run, ownerOf(config), options);
      return { ...result, serverVersion: `Oracle ${conn.oracleServerVersionString}` } satisfies IntrospectResult;
    }),
  execute: (config, statements) =>
    withConnection(config, async (conn) => {
      // Oracle은 DDL마다 바로 커밋되어 되돌릴 수 없다. 실패하면 거기서 멈춘다.
      if (config.schema) await conn.execute(`ALTER SESSION SET CURRENT_SCHEMA = "${config.schema.toUpperCase().replace(/"/g, '')}"`);
      const results: StatementResult[] = [];
      let failed = false;
      for (const sql of statements) {
        if (failed) {
          results.push({ sql, ok: false, skipped: true, ms: 0 });
          continue;
        }
        const start = Date.now();
        try {
          await conn.execute(sql);
          results.push({ sql, ok: true, ms: Date.now() - start });
        } catch (e) {
          failed = true;
          results.push({ sql, ok: false, error: oracleHint(sql, e instanceof Error ? e.message : String(e)), ms: Date.now() - start });
        }
      }
      return { results, ok: !failed, rolledBack: false, appliedCount: results.filter((r) => r.ok).length } satisfies ExecuteResult;
    }),
};

/** 자주 만나는 권한 오류에 무엇이 필요한지 덧붙인다 */
export function oracleHint(sql: string, message: string): string {
  if (/ORA-01031/.test(message)) {
    const need = /GENERATED BY DEFAULT AS IDENTITY/i.test(sql)
      ? 'CREATE TABLE, CREATE SEQUENCE (자동 증가 컬럼은 내부 시퀀스를 만듭니다)'
      : /^ *CREATE +(UNIQUE +)?INDEX/i.test(sql) ? 'CREATE INDEX(또는 CREATE TABLE)' : 'CREATE TABLE · ALTER 권한';
    return `${message}
→ 접속 계정에 권한이 부족합니다. 필요한 권한: ${need}`;
  }
  if (/ORA-01950/.test(message)) return `${message}
→ 테이블스페이스 할당량이 없습니다 (GRANT UNLIMITED TABLESPACE 또는 QUOTA 필요)`;
  return message;
}

/** DATA_DEFAULT(LONG)를 문자열로 받는다 */
function longAsString(metaData: { dbType?: unknown }) {
  if (metaData.dbType === oracledb.DB_TYPE_LONG) return { type: oracledb.STRING };
  return undefined;
}
