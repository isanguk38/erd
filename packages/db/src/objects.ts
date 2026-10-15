// DB 객체 읽기 (뷰·함수·프로시저·트리거·이벤트·패키지). DB가 쓰는 CREATE 문(DDL) 그대로 가져온다.
// 읽다 실패하면(권한 등) objects를 비워 두지 않고 "모름"(undefined)으로 둔다 — 비어 있다고 보면 ERD의 객체를 지우는 변경이 생긴다.

import { objectKey, stripDefiner, type DbObject, type DbObjectKind } from '@erd/core';

type Row = Record<string, any>;

function make(kind: DbObjectKind, name: string, definition: string, table?: string): DbObject {
  const o: DbObject = { id: '', kind, name, definition: stripDefiner(String(definition ?? '')).replace(/\r\n?/g, '\n').trim(), ...(table ? { table } : {}) };
  o.id = `db_o_${objectKey(o)}`;
  return o;
}

/** 같은 키(종류·이름)가 여러 개면(오버로드 함수 등) 첫 것만 두고 알린다 */
function unique(objects: DbObject[], warnings: string[]): DbObject[] {
  const seen = new Set<string>();
  return objects.filter((o) => {
    const k = objectKey(o);
    if (!seen.has(k)) return seen.add(k);
    warnings.push(`${o.name}: 같은 이름의 ${o.kind === 'function' ? '함수' : '객체'}가 여러 개라(오버로드) 첫 번째만 가져옵니다`);
    return false;
  });
}

async function guard(warnings: string[], read: () => Promise<DbObject[]>): Promise<DbObject[] | undefined> {
  try {
    return unique(await read(), warnings);
  } catch (e) {
    warnings.push(`뷰·함수·프로시저 등 DB 객체를 읽지 못했습니다 (권한을 확인하세요): ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
}

// ── PostgreSQL ──────────────────────────────
const pgIdent = (name: string) => (/^[a-z_][a-z0-9_$]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`);
const notExtension = (col: string) => `NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = ${col} AND d.deptype = 'e')`;

export function readPostgresObjects(query: (sql: string, params: unknown[]) => Promise<Row[]>, schemaName: string, warnings: string[]) {
  return guard(warnings, async () => {
    const out: DbObject[] = [];
    for (const r of await query(
      `SELECT c.relname AS name, c.relkind AS kind, pg_get_viewdef(c.oid, true) AS body
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relkind IN ('v', 'm') AND ${notExtension('c.oid')} ORDER BY c.relname`,
      [schemaName],
    )) {
      const body = String(r.body ?? '').trim().replace(/;\s*$/, '');
      out.push(make(r.kind === 'm' ? 'materializedView' : 'view', r.name, `CREATE ${r.kind === 'm' ? 'MATERIALIZED VIEW' : 'VIEW'} ${pgIdent(r.name)} AS\n${body}`));
    }
    for (const r of await query(
      `SELECT p.proname AS name, p.prokind AS kind, pg_get_functiondef(p.oid) AS def
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = $1 AND p.prokind IN ('f', 'p') AND ${notExtension('p.oid')} ORDER BY p.proname, p.oid`,
      [schemaName],
    )) {
      out.push(make(r.kind === 'p' ? 'procedure' : 'function', r.name, r.def));
    }
    for (const r of await query(
      `SELECT t.tgname AS name, c.relname AS table_name, pg_get_triggerdef(t.oid, true) AS def
       FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND NOT t.tgisinternal AND ${notExtension('t.oid')} ORDER BY c.relname, t.tgname`,
      [schemaName],
    )) {
      out.push(make('trigger', r.name, r.def, r.table_name));
    }
    return out;
  });
}

// ── MySQL · MariaDB ──────────────────────────────
const myIdent = (name: string) => '`' + name.replace(/`/g, '``') + '`';

export function readMysqlObjects(query: (sql: string, params: unknown[]) => Promise<Row[]>, database: string, warnings: string[]) {
  return guard(warnings, async () => {
    const out: DbObject[] = [];
    const show = async (what: string, name: string, column: string) => {
      const [row] = await query(`SHOW CREATE ${what} ${myIdent(name)}`, []);
      const def = row?.[column];
      if (!def) warnings.push(`${name}: 정의를 읽을 권한이 없어 가져오지 않습니다`);
      return def ? String(def) : null;
    };
    for (const r of await query(`SELECT TABLE_NAME AS name FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`, [database])) {
      const def = await show('VIEW', r.name, 'Create View');
      if (def) out.push(make('view', r.name, def));
    }
    for (const r of await query(`SELECT ROUTINE_NAME AS name, ROUTINE_TYPE AS type FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_NAME`, [database])) {
      const proc = String(r.type).toUpperCase() === 'PROCEDURE';
      const def = await show(proc ? 'PROCEDURE' : 'FUNCTION', r.name, proc ? 'Create Procedure' : 'Create Function');
      if (def) out.push(make(proc ? 'procedure' : 'function', r.name, def));
    }
    for (const r of await query(`SELECT TRIGGER_NAME AS name, EVENT_OBJECT_TABLE AS table_name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? ORDER BY TRIGGER_NAME`, [database])) {
      const def = await show('TRIGGER', r.name, 'SQL Original Statement');
      if (def) out.push(make('trigger', r.name, def, r.table_name));
    }
    for (const r of await query(`SELECT EVENT_NAME AS name FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ? ORDER BY EVENT_NAME`, [database])) {
      const def = await show('EVENT', r.name, 'Create Event');
      if (def) out.push(make('event', r.name, def));
    }
    return out;
  });
}

// ── SQL Server ──────────────────────────────
const MSSQL_KIND: Record<string, DbObjectKind> = { V: 'view', P: 'procedure', FN: 'function', IF: 'function', TF: 'function', TR: 'trigger' };

export function readMssqlObjects(query: (sql: string, params: Record<string, string>) => Promise<Row[]>, schemaName: string, warnings: string[]) {
  return guard(warnings, async () => {
    const out: DbObject[] = [];
    for (const r of await query(
      `SELECT o.name, RTRIM(o.type) AS type, OBJECT_NAME(o.parent_object_id) AS table_name, m.definition
       FROM sys.objects o JOIN sys.sql_modules m ON m.object_id = o.object_id
       WHERE SCHEMA_NAME(o.schema_id) = @schema AND RTRIM(o.type) IN ('V', 'P', 'FN', 'IF', 'TF', 'TR') AND o.is_ms_shipped = 0
       ORDER BY o.name`,
      { schema: schemaName },
    )) {
      const kind = MSSQL_KIND[String(r.type).trim()];
      if (!kind || !r.definition) continue;
      out.push(make(kind, r.name, r.definition, kind === 'trigger' ? r.table_name : undefined));
    }
    return out;
  });
}

// ── Oracle ──────────────────────────────
const ORACLE_KIND: Record<string, DbObjectKind> = { FUNCTION: 'function', PROCEDURE: 'procedure', TRIGGER: 'trigger', PACKAGE: 'package', 'PACKAGE BODY': 'packageBody' };
const oraIdent = (name: string) => (/^[A-Z][A-Z0-9_$#]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`);

export function readOracleObjects(query: (sql: string, binds: Record<string, string>) => Promise<Row[]>, owner: string, warnings: string[]) {
  return guard(warnings, async () => {
    const out: DbObject[] = [];
    for (const r of await query(`SELECT VIEW_NAME, TEXT FROM ALL_VIEWS WHERE OWNER = :owner ORDER BY VIEW_NAME`, { owner })) {
      out.push(make('view', r.VIEW_NAME, `CREATE OR REPLACE VIEW ${oraIdent(r.VIEW_NAME)} AS\n${String(r.TEXT ?? '').trim()}`));
    }
    const tables = new Map<string, string>();
    for (const r of await query(`SELECT TRIGGER_NAME, TABLE_NAME FROM ALL_TRIGGERS WHERE OWNER = :owner`, { owner })) tables.set(r.TRIGGER_NAME, r.TABLE_NAME);
    // 소스는 줄마다 한 행: 이름·종류별로 이어 붙인다 (TEXT는 "FUNCTION 이름 ..."으로 시작)
    const sources = new Map<string, { name: string; type: string; lines: string[] }>();
    for (const r of await query(
      `SELECT NAME, TYPE, TEXT FROM ALL_SOURCE WHERE OWNER = :owner AND TYPE IN ('FUNCTION', 'PROCEDURE', 'TRIGGER', 'PACKAGE', 'PACKAGE BODY') ORDER BY NAME, TYPE, LINE`,
      { owner },
    )) {
      const k = `${r.TYPE}:${r.NAME}`;
      const s = sources.get(k) ?? { name: String(r.NAME), type: String(r.TYPE), lines: [] as string[] };
      sources.set(k, s);
      s.lines.push(String(r.TEXT ?? ''));
    }
    for (const s of sources.values()) {
      const kind = ORACLE_KIND[s.type];
      if (!kind) continue;
      const text = s.lines.join('').trim();
      out.push(make(kind, s.name, `CREATE OR REPLACE ${text}`, kind === 'trigger' ? tables.get(s.name) : undefined));
    }
    return out;
  });
}
