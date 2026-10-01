// 바깥에서 들어온 스키마(DB에서 읽음, DDL 붙여넣기, AI 제안)를 지금 ERD와 맞추는 도구.
//
// alignToCurrent: 들어온 스키마의 id를 이름 기준으로 지금 ERD의 id로 바꾼다. 그래야 비교 엔진이
//                 "같은 테이블의 변경"으로 인식한다.
// applyChanges:   비교 결과 중 고른 변경만 ERD에 반영한다. 위치·색상·논리명 같은 ERD 정보는 유지한다.

import { diffSchemas, normalizeSchema, type Change, type DiffResult } from './diff';
import type { Dialect } from './dialects/types';
import { cloneSchema, findTable, type Column, type Index, type Relation, type Schema, type Table } from './model';
import { removeColumn, removeTable } from './operations';

const key = (name: string) => name.toLowerCase();

/**
 * 들어온 스키마(incoming)의 id를 지금 ERD(current)에 맞춘다.
 * - 테이블·컬럼: 이름(대소문자 무시)이 같으면 같은 것으로 본다.
 * - 인덱스: 이름이 같거나, 컬럼 구성과 UNIQUE 여부가 같으면 같은 것으로 본다.
 * - 관계: 자식/부모 테이블과 컬럼이 같으면 같은 것으로 본다.
 * ERD에만 있는 정보(위치, 색상, 관계 1:1/1:N, 들어온 쪽에 없는 논리명)도 가져온다.
 */
export function alignToCurrent(incomingInput: Schema, currentInput: Schema): Schema {
  const incoming = cloneSchema(incomingInput);
  const current = normalizeSchema(currentInput);
  const currentTables = new Map(current.tables.map((t) => [key(t.name), t]));
  const tableIdMap = new Map<string, string>();
  const columnIdMap = new Map<string, string>();

  for (const table of incoming.tables) {
    const match = currentTables.get(key(table.name));
    if (!match) continue;
    tableIdMap.set(table.id, match.id);
    table.id = match.id;
    table.position = { ...match.position };
    table.color = match.color;
    if (!table.logicalName) table.logicalName = match.logicalName;
    if (!table.comment && !table.logicalName) table.comment = match.comment;

    const currentColumns = new Map(match.columns.map((c) => [key(c.name), c]));
    for (const column of table.columns) {
      const m = currentColumns.get(key(column.name));
      if (!m) continue;
      columnIdMap.set(column.id, m.id);
      column.id = m.id;
      if (!column.logicalName && !column.comment) {
        column.logicalName = m.logicalName;
        column.comment = m.comment;
      }
    }
    for (const index of table.indexes) index.columnIds = index.columnIds.map((id) => columnIdMap.get(id) ?? id);

    const used = new Set<string>();
    for (const index of table.indexes) {
      const m =
        match.indexes.find((i) => !used.has(i.id) && i.name && index.name && key(i.name) === key(index.name)) ??
        match.indexes.find((i) => !used.has(i.id) && i.unique === index.unique && sameList(i.columnIds, index.columnIds));
      if (!m) continue;
      used.add(m.id);
      index.id = m.id;
    }
  }

  for (const relation of incoming.relations) {
    relation.fromTableId = tableIdMap.get(relation.fromTableId) ?? relation.fromTableId;
    relation.toTableId = tableIdMap.get(relation.toTableId) ?? relation.toTableId;
    relation.fromColumnIds = relation.fromColumnIds.map((id) => columnIdMap.get(id) ?? id);
    relation.toColumnIds = relation.toColumnIds.map((id) => columnIdMap.get(id) ?? id);
  }
  const usedRelations = new Set<string>();
  for (const relation of incoming.relations) {
    const m = current.relations.find(
      (r) =>
        !usedRelations.has(r.id) &&
        r.fromTableId === relation.fromTableId &&
        r.toTableId === relation.toTableId &&
        sameList(r.fromColumnIds, relation.fromColumnIds) &&
        sameList(r.toColumnIds, relation.toColumnIds),
    );
    if (!m) continue;
    usedRelations.add(m.id);
    relation.id = m.id;
    relation.cardinality = m.cardinality;
  }
  return incoming;
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** 들어온 스키마와 지금 ERD를 비교한다 (지금 ERD → 들어온 스키마로 가는 변경). */
export function diffIncoming(current: Schema, incoming: Schema, dialect: Dialect): DiffResult {
  return diffSchemas(current, alignToCurrent(incoming, current), dialect);
}

/**
 * diff(base → target) 중 selected에 든 변경만 base에 반영한 새 스키마를 만든다.
 * base는 diff를 만들 때 쓴 원본(정규화 전) 스키마를 넘긴다.
 */
export function applyChanges(baseInput: Schema, diff: DiffResult, selected?: Set<string>): Schema {
  const schema = cloneSchema(baseInput);
  const changes = diff.changes.filter((c) => !selected || selected.has(c.id));
  const tableIdOf = (change: Change): string | undefined => {
    switch (change.kind) {
      case 'createTable':
      case 'dropTable':
      case 'tableComment':
      case 'addColumn':
      case 'dropColumn':
      case 'alterColumn':
      case 'addIndex':
      case 'dropIndex':
        return change.table.id;
      case 'renameTable':
      case 'primaryKey':
        return change.after.id;
      default:
        return undefined;
    }
  };

  // 테이블 생성/삭제 먼저, 그다음 테이블 안 변경, 마지막에 관계
  for (const change of changes) {
    if (change.kind === 'createTable') {
      schema.tables.push({ ...cloneSchema({ tables: [change.table], relations: [] }).tables[0], indexes: [] });
    } else if (change.kind === 'dropTable') {
      removeTable(schema, change.table.id);
    }
  }

  for (const change of changes) {
    const tableId = tableIdOf(change);
    const table = tableId ? findTable(schema, tableId) : undefined;
    switch (change.kind) {
      case 'renameTable':
        if (table) table.name = change.after.name;
        break;
      case 'tableComment':
        if (table) {
          table.comment = change.table.comment;
          table.logicalName = change.table.logicalName;
        }
        break;
      case 'addColumn':
        if (table && !table.columns.some((c) => c.id === change.column.id)) {
          const prevIndex = change.previous ? table.columns.findIndex((c) => c.id === change.previous!.id) : -1;
          table.columns.splice(prevIndex + 1, 0, copyColumn(change.column));
        }
        break;
      case 'dropColumn':
        if (table) removeColumn(schema, table.id, change.column.id);
        break;
      case 'alterColumn':
        if (table) {
          const i = table.columns.findIndex((c) => c.id === change.after.id);
          if (i >= 0) table.columns[i] = { ...copyColumn(change.after), primaryKey: table.columns[i].primaryKey, unique: table.columns[i].unique };
        }
        break;
      case 'primaryKey':
        if (table) {
          const pk = new Set(change.after.columns.filter((c) => c.primaryKey).map((c) => c.id));
          for (const c of table.columns) {
            c.primaryKey = pk.has(c.id);
            if (c.primaryKey) c.nullable = false;
          }
        }
        break;
      case 'addIndex':
        if (table) addIndexOrFlag(table, change.index);
        break;
      case 'dropIndex':
        if (table) dropIndexOrFlag(table, change.index);
        break;
    }
  }

  for (const change of changes) {
    if (change.kind === 'dropForeignKey') {
      schema.relations = schema.relations.filter((r) => r.id !== change.relation.id);
    } else if (change.kind === 'addForeignKey') {
      const relation: Relation = structuredClone(change.relation);
      schema.relations = schema.relations.filter((r) => r.id !== relation.id);
      const from = findTable(schema, relation.fromTableId);
      const to = findTable(schema, relation.toTableId);
      const ok = from && to && relation.fromColumnIds.every((id) => from.columns.some((c) => c.id === id)) && relation.toColumnIds.every((id) => to.columns.some((c) => c.id === id));
      if (ok) schema.relations.push(relation);
    }
  }
  return schema;
}

function copyColumn(column: Column): Column {
  return { ...column };
}

/** 비교용으로 만든 UNIQUE 인덱스(uq_컬럼id)는 다시 컬럼의 UNIQUE 표시로 되돌린다. */
function addIndexOrFlag(table: Table, index: Index) {
  const synthetic = index.id.startsWith('uq_') && index.columnIds.length === 1 && !index.name;
  if (synthetic) {
    const column = table.columns.find((c) => c.id === index.columnIds[0]);
    if (column) column.unique = true;
    return;
  }
  table.indexes = table.indexes.filter((i) => i.id !== index.id);
  const columnIds = index.columnIds.filter((id) => table.columns.some((c) => c.id === id));
  if (columnIds.length) table.indexes.push({ ...index, columnIds });
}

function dropIndexOrFlag(table: Table, index: Index) {
  if (index.id.startsWith('uq_')) {
    const column = table.columns.find((c) => `uq_${c.id}` === index.id);
    if (column) column.unique = false;
  }
  table.indexes = table.indexes.filter((i) => i.id !== index.id);
}
