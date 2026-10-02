// 스키마 편집 동작. 화면, 실시간 동기화, MCP(AI)가 모두 이 함수들로 스키마를 바꾼다.
// 모든 함수는 전달받은 schema를 직접 수정한다.

import {
  createColumn,
  createIndex,
  createRelation,
  createTable,
  findTable,
  primaryKeyColumns,
  type Cardinality,
  type Column,
  type Index,
  type Relation,
  type Schema,
  type Table,
} from './model';

function requireTable(schema: Schema, tableId: string): Table {
  const table = findTable(schema, tableId);
  if (!table) throw new Error(`테이블을 찾을 수 없습니다: ${tableId}`);
  return table;
}

function requireColumn(table: Table, columnId: string): Column {
  const column = table.columns.find((c) => c.id === columnId);
  if (!column) throw new Error(`컬럼을 찾을 수 없습니다: ${table.name}.${columnId}`);
  return column;
}

export function uniqueTableName(schema: Schema, base: string): string {
  const names = new Set(schema.tables.map((t) => t.name));
  if (!names.has(base)) return base;
  for (let i = 2; ; i++) if (!names.has(`${base}_${i}`)) return `${base}_${i}`;
}

export function uniqueColumnName(table: Table, base: string): string {
  const names = new Set(table.columns.map((c) => c.name));
  if (!names.has(base)) return base;
  for (let i = 2; ; i++) if (!names.has(`${base}_${i}`)) return `${base}_${i}`;
}

export function addTable(schema: Schema, partial: Partial<Table> = {}): Table {
  const table = createTable(partial);
  if (!partial.name) table.name = uniqueTableName(schema, 'new_table');
  schema.tables.push(table);
  return table;
}

export function updateTable(schema: Schema, tableId: string, patch: Partial<Omit<Table, 'id' | 'columns' | 'indexes'>>): Table {
  const table = requireTable(schema, tableId);
  Object.assign(table, patch);
  return table;
}

export function removeTable(schema: Schema, tableId: string): void {
  schema.tables = schema.tables.filter((t) => t.id !== tableId);
  schema.relations = schema.relations.filter((r) => r.fromTableId !== tableId && r.toTableId !== tableId);
  if (schema.areas) for (const a of schema.areas) if (a.tableIds.includes(tableId)) a.tableIds = a.tableIds.filter((id) => id !== tableId);
}

export function addColumn(schema: Schema, tableId: string, partial: Partial<Column> = {}, position?: number): Column {
  const table = requireTable(schema, tableId);
  const column = createColumn(partial);
  if (!partial.name) column.name = uniqueColumnName(table, 'column');
  if (column.primaryKey) column.nullable = false;
  if (position === undefined || position >= table.columns.length) table.columns.push(column);
  else table.columns.splice(Math.max(0, position), 0, column);
  return column;
}

export function updateColumn(schema: Schema, tableId: string, columnId: string, patch: Partial<Omit<Column, 'id'>>): Column {
  const table = requireTable(schema, tableId);
  const column = requireColumn(table, columnId);
  Object.assign(column, patch);
  if (column.primaryKey) column.nullable = false;
  return column;
}

/** 컬럼을 지우면 그 컬럼을 쓰는 인덱스와 관계도 정리한다. */
export function removeColumn(schema: Schema, tableId: string, columnId: string): void {
  const table = requireTable(schema, tableId);
  table.columns = table.columns.filter((c) => c.id !== columnId);
  table.indexes = table.indexes
    .map((i) => ({ ...i, columnIds: i.columnIds.filter((id) => id !== columnId) }))
    .filter((i) => i.columnIds.length > 0);
  schema.relations = schema.relations.filter(
    (r) => !(r.fromTableId === tableId && r.fromColumnIds.includes(columnId)) && !(r.toTableId === tableId && r.toColumnIds.includes(columnId)),
  );
}

export function moveColumn(schema: Schema, tableId: string, columnId: string, toIndex: number): void {
  const table = requireTable(schema, tableId);
  const from = table.columns.findIndex((c) => c.id === columnId);
  if (from < 0) return;
  const [column] = table.columns.splice(from, 1);
  table.columns.splice(Math.max(0, Math.min(toIndex, table.columns.length)), 0, column);
}

export function addIndex(schema: Schema, tableId: string, partial: Partial<Index> = {}): Index {
  const table = requireTable(schema, tableId);
  for (const id of partial.columnIds ?? []) requireColumn(table, id);
  const index = createIndex(partial);
  table.indexes.push(index);
  return index;
}

export function updateIndex(schema: Schema, tableId: string, indexId: string, patch: Partial<Omit<Index, 'id'>>): Index {
  const table = requireTable(schema, tableId);
  const index = table.indexes.find((i) => i.id === indexId);
  if (!index) throw new Error(`인덱스를 찾을 수 없습니다: ${indexId}`);
  Object.assign(index, patch);
  return index;
}

export function removeIndex(schema: Schema, tableId: string, indexId: string): void {
  const table = requireTable(schema, tableId);
  table.indexes = table.indexes.filter((i) => i.id !== indexId);
}

export interface ConnectOptions {
  parentTableId: string;
  childTableId: string;
  cardinality?: Cardinality;
  /** 식별 관계: 자식의 FK 컬럼이 기본키에도 포함된다 */
  identifying?: boolean;
  onDelete?: Relation['onDelete'];
  onUpdate?: Relation['onUpdate'];
}

/** 기본키가 "id"처럼 테이블 이름 없는 이름인지 */
const isGenericKey = (name: string) => /^id$/i.test(name);

/** 영어 복수형 테이블 이름을 단수로 (products → product, categories → category) */
function singular(name: string): string {
  if (/ies$/i.test(name)) return name.slice(0, -3) + 'y';
  if (/(ss|x|ch|sh)es$/i.test(name)) return name.slice(0, -2);
  if (/[^s]s$/i.test(name)) return name.slice(0, -1);
  return name;
}

/**
 * 자식에 만들 FK 컬럼 이름. 부모 기본키가 member_id처럼 이름이 있으면 그대로 쓰고,
 * "id"처럼 흔한 이름이면 자식의 "id"와 겹치지 않게 테이블 이름을 붙인다
 * (camelCase 스키마면 productId, 아니면 product_id).
 */
function fkColumnName(parent: Table, child: Table, parentColumn: Column): string {
  const self = child.id === parent.id;
  if (!isGenericKey(parentColumn.name)) return self ? `parent_${parentColumn.name}` : parentColumn.name;
  const camel = [...child.columns, ...parent.columns].some((c) => /^[a-z]+[A-Z]/.test(c.name));
  const words = (self ? 'parent' : singular(parent.name)).split(/[_\s]+/).filter(Boolean);
  if (!camel) return `${words.join('_')}_${parentColumn.name.toLowerCase()}`;
  return words.map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase())).join('') + 'Id';
}

/**
 * 부모 테이블의 기본키를 참조하는 외래키를 만든다.
 * 자식 테이블에 같은 이름의 컬럼이 있으면 그 컬럼을 쓰고, 없으면 새로 만든다.
 */
export function connectTables(schema: Schema, options: ConnectOptions): Relation {
  const parent = requireTable(schema, options.parentTableId);
  const child = requireTable(schema, options.childTableId);
  const pk = primaryKeyColumns(parent);
  if (pk.length === 0) throw new Error(`${parent.name} 테이블에 기본키가 없어 관계를 만들 수 없습니다`);

  const fromColumnIds: string[] = [];
  for (const parentColumn of pk) {
    const generic = isGenericKey(parentColumn.name);
    const base = fkColumnName(parent, child, parentColumn);
    const existing = child.columns.find((c) => c.name === base && c.id !== parentColumn.id);
    if (existing && child.id !== parent.id) {
      if (options.identifying) existing.primaryKey = true;
      fromColumnIds.push(existing.id);
      continue;
    }
    const column = createColumn({
      name: uniqueColumnName(child, base),
      logicalName: generic && !parentColumn.logicalName && parent.logicalName ? `${parent.logicalName} ID` : parentColumn.logicalName,
      type: parentColumn.type,
      length: parentColumn.length,
      nullable: child.id === parent.id,
      primaryKey: Boolean(options.identifying) && child.id !== parent.id,
      comment: parentColumn.comment,
    });
    const lastPk = child.columns.reduce((acc, c, i) => (c.primaryKey ? i : acc), -1);
    child.columns.splice(column.primaryKey ? lastPk + 1 : child.columns.length, 0, column);
    fromColumnIds.push(column.id);
  }

  const relation = createRelation({
    fromTableId: child.id,
    fromColumnIds,
    toTableId: parent.id,
    toColumnIds: pk.map((c) => c.id),
    cardinality: options.cardinality ?? '1:N',
    onDelete: options.onDelete ?? 'NO ACTION',
    onUpdate: options.onUpdate ?? 'NO ACTION',
  });
  schema.relations.push(relation);
  return relation;
}

/**
 * N:M 관계: 두 테이블 사이에 연결 테이블을 만들고 1:N 관계 두 개로 잇는다.
 */
export function connectManyToMany(schema: Schema, aTableId: string, bTableId: string): { table: Table; relations: Relation[] } {
  const a = requireTable(schema, aTableId);
  const b = requireTable(schema, bTableId);
  const table = addTable(schema, {
    name: uniqueTableName(schema, `${a.name}_${b.name}`),
    logicalName: a.logicalName && b.logicalName ? `${a.logicalName}_${b.logicalName}` : '',
    position: { x: (a.position.x + b.position.x) / 2, y: Math.max(a.position.y, b.position.y) + 200 },
  });
  const relations = [
    connectTables(schema, { parentTableId: a.id, childTableId: table.id, identifying: true }),
    connectTables(schema, { parentTableId: b.id, childTableId: table.id, identifying: true }),
  ];
  return { table, relations };
}

export function updateRelation(schema: Schema, relationId: string, patch: Partial<Omit<Relation, 'id'>>): Relation {
  const relation = schema.relations.find((r) => r.id === relationId);
  if (!relation) throw new Error(`관계를 찾을 수 없습니다: ${relationId}`);
  Object.assign(relation, patch);
  return relation;
}

/** 관계를 지운다. dropColumns이면 관계 때문에 생긴 자식 쪽 FK 컬럼도 지운다. */
export function removeRelation(schema: Schema, relationId: string, dropColumns = false): void {
  const relation = schema.relations.find((r) => r.id === relationId);
  if (!relation) return;
  schema.relations = schema.relations.filter((r) => r.id !== relationId);
  if (dropColumns) for (const id of relation.fromColumnIds) removeColumn(schema, relation.fromTableId, id);
}

/** 다른 관계의 FK로 쓰이는 컬럼 id 목록 */
export function foreignKeyColumnIds(schema: Schema, tableId: string): Set<string> {
  const ids = new Set<string>();
  for (const r of schema.relations) if (r.fromTableId === tableId) r.fromColumnIds.forEach((id) => ids.add(id));
  return ids;
}
