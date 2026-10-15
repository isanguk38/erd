// 스키마 ↔ Yjs 문서.
// 실시간 동시 편집을 위해 스키마를 Yjs 구조로 저장한다. 편집 코드는 지금처럼 Schema를 바꾸고,
// writeSchema가 바뀐 필드만 Yjs에 반영한다. 그래서 두 사람이 다른 컬럼을 동시에 고쳐도 둘 다 남는다.
//
// erd (Y.Map)
//  ├ meta (Y.Map): name, dialect, aiMode ...
//  ├ tables (Y.Map<tableId, Y.Map>): 테이블 필드 + columns(Y.Array<Y.Map>) + indexes(Y.Array<Index>)
//  ├ relations (Y.Map<relationId, Y.Map>)
//  └ areas (Y.Map<areaId, Y.Map>): 주제영역. name, color, tableIds, positions, order

import * as Y from 'yjs';
import type { AiReview } from './aiReview';
import { namingSettingValue, readNamingSetting, type NamingSetting } from './naming';
import type { Area, CheckConstraint, Column, EnumType, Index, Relation, Schema, Table } from './model';
import type { DbObject, DbObjectKind } from './dbObjects';

const TABLE_FIELDS = ['name', 'logicalName', 'comment', 'color', 'primaryKeyName', 'position', 'order'] as const;
const COLUMN_FIELDS = ['name', 'logicalName', 'type', 'length', 'nullable', 'primaryKey', 'unique', 'autoIncrement', 'defaultValue', 'onUpdate', 'generated', 'comment'] as const;
const RELATION_FIELDS = ['name', 'fromTableId', 'fromColumnIds', 'toTableId', 'toColumnIds', 'cardinality', 'onDelete', 'onUpdate'] as const;
const AREA_FIELDS = ['name', 'color', 'tableIds', 'positions'] as const;

export function rootMap(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap('erd');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function child<T extends Y.AbstractType<any>>(map: Y.Map<unknown>, key: string, make: () => T): T {
  let value = map.get(key) as T | undefined;
  if (!value) {
    value = make();
    map.set(key, value);
  }
  return value;
}

export function metaMap(doc: Y.Doc): Y.Map<unknown> {
  return child(rootMap(doc), 'meta', () => new Y.Map());
}

function tablesMap(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return child(rootMap(doc), 'tables', () => new Y.Map()) as Y.Map<Y.Map<unknown>>;
}

function relationsMap(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return child(rootMap(doc), 'relations', () => new Y.Map()) as Y.Map<Y.Map<unknown>>;
}

function objectsMap(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return child(rootMap(doc), 'objects', () => new Y.Map()) as Y.Map<Y.Map<unknown>>;
}

function enumsMap(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return child(rootMap(doc), 'enums', () => new Y.Map()) as Y.Map<Y.Map<unknown>>;
}

function areasMap(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return child(rootMap(doc), 'areas', () => new Y.Map()) as Y.Map<Y.Map<unknown>>;
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** 값이 다를 때만 쓴다 (불필요한 변경 이벤트를 막는다) */
function setIfChanged(map: Y.Map<unknown>, key: string, value: unknown): void {
  if (value === undefined) {
    if (map.has(key)) map.delete(key);
    return;
  }
  if (!same(map.get(key), value)) map.set(key, value);
}

function columnToY(column: Column): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  m.set('id', column.id);
  for (const f of COLUMN_FIELDS) if (column[f] !== undefined) m.set(f, column[f]);
  return m;
}

function writeColumns(arr: Y.Array<Y.Map<unknown>>, columns: Column[]): void {
  const wanted = new Set(columns.map((c) => c.id));
  // 1) 없어진 컬럼 삭제 (뒤에서부터)
  for (let i = arr.length - 1; i >= 0; i--) {
    if (!wanted.has(arr.get(i).get('id') as string)) arr.delete(i, 1);
  }
  // 2) 순서대로 맞추기: 같은 자리면 필드만 갱신, 아니면 옮기거나 새로 넣는다
  columns.forEach((column, i) => {
    const current = i < arr.length ? arr.get(i) : undefined;
    if (current && current.get('id') === column.id) {
      for (const f of COLUMN_FIELDS) setIfChanged(current, f, column[f]);
      return;
    }
    for (let j = i + 1; j < arr.length; j++) {
      if (arr.get(j).get('id') === column.id) {
        arr.delete(j, 1);
        break;
      }
    }
    arr.insert(i, [columnToY(column)]);
  });
}

function writeTable(map: Y.Map<unknown>, table: Table, order: number): void {
  setIfChanged(map, 'id', table.id);
  for (const f of TABLE_FIELDS) setIfChanged(map, f, f === 'order' ? order : table[f]);
  writeColumns(child(map, 'columns', () => new Y.Array<Y.Map<unknown>>()), table.columns);
  // 인덱스는 통째로 바꿔도 충분하다 (자주, 동시에 고치는 부분이 아님)
  setIfChanged(map, 'indexes', table.indexes);
  setIfChanged(map, 'checks', table.checks?.length ? table.checks : undefined);
}

/** schema와 다른 부분만 문서에 반영한다. 호출하는 쪽에서 doc.transact로 감싸 origin을 붙인다. */
export function writeSchema(doc: Y.Doc, schema: Schema): void {
  const tables = tablesMap(doc);
  const wantedTables = new Set(schema.tables.map((t) => t.id));
  for (const id of [...tables.keys()]) if (!wantedTables.has(id)) tables.delete(id);
  schema.tables.forEach((table, order) => {
    let map = tables.get(table.id);
    if (!map) {
      map = new Y.Map();
      tables.set(table.id, map);
    }
    writeTable(map, table, order);
  });

  const relations = relationsMap(doc);
  const wantedRelations = new Set(schema.relations.map((r) => r.id));
  for (const id of [...relations.keys()]) if (!wantedRelations.has(id)) relations.delete(id);
  for (const relation of schema.relations) {
    let map = relations.get(relation.id);
    if (!map) {
      map = new Y.Map();
      relations.set(relation.id, map);
    }
    setIfChanged(map, 'id', relation.id);
    for (const f of RELATION_FIELDS) setIfChanged(map, f, relation[f]);
  }

  // 사용자 정의 타입: enums를 넘긴 경우에만 맞춘다 (모르는 쪽이 저장해도 타입은 남는다)
  if (schema.enums && (schema.enums.length || rootMap(doc).has('enums'))) {
    const enums = enumsMap(doc);
    const wanted = new Set(schema.enums.map((e) => e.id));
    for (const id of [...enums.keys()]) if (!wanted.has(id)) enums.delete(id);
    schema.enums.forEach((e, order) => {
      let map = enums.get(e.id);
      if (!map) {
        map = new Y.Map();
        enums.set(e.id, map);
      }
      setIfChanged(map, 'name', e.name);
      setIfChanged(map, 'values', e.values);
      setIfChanged(map, 'comment', e.comment?.trim() ? e.comment : undefined);
      setIfChanged(map, 'order', order);
    });
  }

  // DB 객체(뷰·함수 등): objects를 넘긴 경우에만 맞춘다 (모르는 쪽 — SQL 붙여넣기 등 — 이 저장해도 남는다)
  if (schema.objects && (schema.objects.length || rootMap(doc).has('objects'))) {
    const objects = objectsMap(doc);
    const wanted = new Set(schema.objects.map((o) => o.id));
    for (const id of [...objects.keys()]) if (!wanted.has(id)) objects.delete(id);
    schema.objects.forEach((o, order) => {
      let map = objects.get(o.id);
      if (!map) {
        map = new Y.Map();
        objects.set(o.id, map);
      }
      setIfChanged(map, 'kind', o.kind);
      setIfChanged(map, 'name', o.name);
      setIfChanged(map, 'table', o.table || undefined);
      setIfChanged(map, 'definition', o.definition);
      setIfChanged(map, 'comment', o.comment?.trim() ? o.comment : undefined);
      setIfChanged(map, 'order', order);
    });
  }

  // 영역: areas를 넘긴 경우에만 맞춘다 (영역을 모르는 쪽 — DB 가져오기·SQL 붙여넣기 등 — 이 저장해도 영역은 남는다)
  if (schema.areas) {
    const areas = areasMap(doc);
    const wantedAreas = new Set(schema.areas.map((a) => a.id));
    for (const id of [...areas.keys()]) if (!wantedAreas.has(id)) areas.delete(id);
    schema.areas.forEach((area, order) => {
      let map = areas.get(area.id);
      if (!map) {
        map = new Y.Map();
        areas.set(area.id, map);
      }
      setIfChanged(map, 'id', area.id);
      for (const f of AREA_FIELDS) setIfChanged(map, f, f === 'positions' && area.positions && !Object.keys(area.positions).length ? undefined : area[f]);
      setIfChanged(map, 'order', order);
    });
  }
}

export function readSchema(doc: Y.Doc): Schema {
  const root = rootMap(doc);
  const tablesY = root.get('tables') as Y.Map<Y.Map<unknown>> | undefined;
  const relationsY = root.get('relations') as Y.Map<Y.Map<unknown>> | undefined;
  const tables: (Table & { order: number })[] = [];
  tablesY?.forEach((map, id) => {
    const columnsY = map.get('columns') as Y.Array<Y.Map<unknown>> | undefined;
    const columns: Column[] = (columnsY?.toArray() ?? []).map((c) => {
      const column = { id: c.get('id') } as Column;
      for (const f of COLUMN_FIELDS) if (c.has(f)) (column as unknown as Record<string, unknown>)[f] = c.get(f);
      if (column.defaultValue === undefined) column.defaultValue = null;
      return column;
    });
    const table: Table & { order: number } = {
      id,
      name: (map.get('name') as string) ?? '',
      logicalName: (map.get('logicalName') as string) ?? '',
      comment: (map.get('comment') as string) ?? '',
      position: (map.get('position') as Table['position']) ?? { x: 0, y: 0 },
      columns,
      indexes: structuredClone((map.get('indexes') as Index[]) ?? []),
      ...(map.has('checks') ? { checks: structuredClone(map.get('checks') as CheckConstraint[]) } : {}),
      order: (map.get('order') as number) ?? 0,
    };
    const color = map.get('color') as string | undefined;
    if (color) table.color = color;
    const pkName = map.get('primaryKeyName') as string | undefined;
    if (pkName) table.primaryKeyName = pkName;
    tables.push(table);
  });
  tables.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));

  const relations: Relation[] = [];
  relationsY?.forEach((map, id) => {
    const relation = { id } as Relation;
    for (const f of RELATION_FIELDS) (relation as unknown as Record<string, unknown>)[f] = structuredClone(map.get(f));
    relations.push(relation);
  });
  relations.sort((a, b) => a.id.localeCompare(b.id));

  // 영역: 지워진 테이블은 빼고 읽는다 (다른 사람이 테이블을 지운 경우 등)
  const areasY = root.get('areas') as Y.Map<Y.Map<unknown>> | undefined;
  const tableIds = new Set(tables.map((t) => t.id));
  const areas: (Area & { order: number })[] = [];
  areasY?.forEach((map, id) => {
    const positions = structuredClone((map.get('positions') as Area['positions']) ?? {});
    for (const k of Object.keys(positions)) if (!tableIds.has(k)) delete positions[k];
    const area: Area & { order: number } = {
      id,
      name: (map.get('name') as string) ?? '',
      tableIds: ((map.get('tableIds') as string[]) ?? []).filter((t) => tableIds.has(t)),
      ...(Object.keys(positions).length ? { positions } : {}),
      order: (map.get('order') as number) ?? 0,
    };
    const color = map.get('color') as string | undefined;
    if (color) area.color = color;
    areas.push(area);
  });
  areas.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));

  const enumsY = root.get('enums') as Y.Map<Y.Map<unknown>> | undefined;
  const enums: (EnumType & { order: number })[] = [];
  enumsY?.forEach((map, id) => {
    const e: EnumType & { order: number } = { id, name: (map.get('name') as string) ?? '', values: [...((map.get('values') as string[]) ?? [])], order: (map.get('order') as number) ?? 0 };
    const comment = map.get('comment') as string | undefined;
    if (comment) e.comment = comment;
    enums.push(e);
  });
  enums.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));

  const objectsY = root.get('objects') as Y.Map<Y.Map<unknown>> | undefined;
  const objects: (DbObject & { order: number })[] = [];
  objectsY?.forEach((map, id) => {
    const o: DbObject & { order: number } = { id, kind: map.get('kind') as DbObjectKind, name: (map.get('name') as string) ?? '', definition: (map.get('definition') as string) ?? '', order: (map.get('order') as number) ?? 0 };
    const table = map.get('table') as string | undefined;
    if (table) o.table = table;
    const comment = map.get('comment') as string | undefined;
    if (comment) o.comment = comment;
    objects.push(o);
  });
  objects.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));

  const schema: Schema = { tables: tables.map(({ order: _order, ...t }) => t), relations };
  // ERD 문서는 DB 객체 정보도 늘 가진다 (없으면 []). 객체를 모르는 쪽(SQL 붙여넣기 등)과 구분한다
  schema.objects = objects.map(({ order: _order, ...o }) => o);
  // ERD 문서는 타입 정보를 늘 가진다 (없으면 []). 비교할 때 '타입을 모르는 쪽'(MySQL DB 등)과 구분한다
  schema.enums = enums.map(({ order: _order, ...e }) => e);
  if (areas.length) schema.areas = areas.map(({ order: _order, ...a }) => a);
  return schema;
}

export interface ProjectMeta {
  name: string;
  dialect: string;
  /** AI(MCP)가 바꿀 때 기본 방식: 바로 적용 / 제안 */
  aiMode?: 'apply' | 'propose';
  /** AI가 DB에 SQL을 실행하도록 허용할지 (기본 false) */
  aiAllowDbExecute?: boolean;
  /** 진행 중인 AI 작업 (되돌리기용) */
  aiSession?: { versionId: string; startedAt: string; changeCount: number; lastAt: string } | null;
  /** 대기 중인 AI 제안 수 (서버가 갱신) */
  pendingProposals?: number;
  /** 이 프로젝트와 연결한 DB (서버의 연결 id). 함께 작업하는 사람 모두가 같은 DB를 본다 */
  dbConnectionId?: string | null;
  /** 설계 검사에서 무시하기로 한 항목 id (기본 검사·AI 검토 모두) */
  lintIgnored?: string[];
  /** MCP로 연결한 AI의 설계 검토 결과 (aiReview.ts) */
  aiReview?: AiReview | null;
  /** 이름 표기 기준 (naming.ts) — 테이블·컬럼 따로. 없으면(또는 null인 쪽은) 사전 표기·지금 이름들로 판단 */
  namingStyle?: NamingSetting | null;
}

export function readMeta(doc: Y.Doc): ProjectMeta {
  const meta = metaMap(doc);
  return {
    name: (meta.get('name') as string) ?? '',
    dialect: (meta.get('dialect') as string) ?? 'mysql',
    aiMode: (meta.get('aiMode') as ProjectMeta['aiMode']) ?? 'apply',
    aiAllowDbExecute: Boolean(meta.get('aiAllowDbExecute')),
    aiSession: (meta.get('aiSession') as ProjectMeta['aiSession']) ?? null,
    pendingProposals: (meta.get('pendingProposals') as number) ?? 0,
    dbConnectionId: (meta.get('dbConnectionId') as string) ?? null,
    lintIgnored: Array.isArray(meta.get('lintIgnored')) ? [...(meta.get('lintIgnored') as string[])] : [],
    aiReview: (meta.get('aiReview') as AiReview | undefined) ?? null,
    namingStyle: readNamingSetting(meta.get('namingStyle')),
  };
}

export function writeMeta(doc: Y.Doc, patch: Partial<ProjectMeta>): void {
  const meta = metaMap(doc);
  for (const [k, raw] of Object.entries(patch)) {
    // 표기 기준은 짧게 저장한다 (테이블·컬럼이 같으면 문자열 하나)
    const v = k === 'namingStyle' ? namingSettingValue(raw as NamingSetting | null) : raw;
    setIfChanged(meta, k, v === null ? undefined : v);
  }
}
