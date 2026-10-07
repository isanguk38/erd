import { diffSchemas, foreignKeyColumnIds, type Dialect, type Schema, type Table } from '@erd/core';
import type { Peer, ViewMode } from '../store';
import type { TableNodeType } from '../components/TableNode';
import type { RelationEdgeType } from '../components/RelationEdge';

/** 화면 맞추기 최대 배율: 테이블이 하나뿐일 때 2배로 커져 편집 창에 가리지 않게 */
export const FIT_MAX_ZOOM = 1;

/** 테이블에 붙는 표시: 다른 사람이 방금 바꾼 곳, 열린 댓글 수 */
export interface NodeMarks {
  remote?: Record<string, { added: boolean; columnIds: string[] }>;
  comments?: Map<string, { open: number; review: number; columnIds: Set<string> }>;
}


/** 스키마 → React Flow 노드. 이전 노드의 측정 크기는 유지한다 (관계선 계산에 필요). */
/** 검색 중 강조: 맞는 테이블·컬럼, 결과에서 고른 것 */
export interface SearchMarks {
  tables: Set<string>;
  columns: Set<string>;
  focus: { tableId: string; columnId?: string } | null;
}

export function buildNodes(
  schema: Schema,
  viewMode: ViewMode,
  selectedIds: ReadonlySet<string>,
  prev: TableNodeType[] = [],
  peers: Peer[] = [],
  search: SearchMarks | null = null,
  marks: NodeMarks = {},
): TableNodeType[] {
  const measured = new Map(prev.map((n) => [n.id, n.measured]));
  const peerMarks = (tableId: string) =>
    peers.filter((p) => p.selection?.type === 'table' && p.selection.id === tableId).map((p) => ({ name: p.name, color: p.color }));
  return schema.tables.map((table) => ({
    id: table.id,
    type: 'table',
    position: table.position,
    selected: selectedIds.has(table.id),
    measured: measured.get(table.id),
    data: {
      table,
      fkIds: [...foreignKeyColumnIds(schema, table.id)],
      viewMode,
      peers: peerMarks(table.id),
      search: search ? (search.tables.has(table.id) ? 'match' : 'dim') : undefined,
      matchColumnIds: search ? table.columns.filter((c) => search.columns.has(c.id)).map((c) => c.id) : undefined,
      focusColumnId: search?.focus?.tableId === table.id ? search.focus.columnId ?? '*' : undefined,
      remote: marks.remote?.[table.id],
      comments: marks.comments?.get(table.id),
    },
  }));
}

export function buildEdges(schema: Schema, selectedId: string | null): RelationEdgeType[] {
  return schema.relations.map((r) => ({
    id: r.id,
    type: 'relation',
    source: r.toTableId, // 부모
    target: r.fromTableId, // 자식
    selected: r.id === selectedId,
    data: { cardinality: r.cardinality },
  }));
}


// ── 버전 비교 화면 ─────────────────────────────

export type Mark = 'added' | 'changed' | 'removed';

/**
 * 기준(이전 버전)과 지금 ERD를 한 캔버스에 겹쳐 그린다.
 * 지금 있는 테이블 + 사라진 테이블(이전 위치), 사라진 컬럼은 원래 자리에 취소선으로 남긴다.
 */
export function buildCompareGraph(base: Schema, target: Schema, dialect: Dialect, viewMode: ViewMode, prev: TableNodeType[] = []) {
  const diff = diffSchemas(base, target, dialect);
  const measured = new Map(prev.map((n) => [n.id, n.measured]));
  const tableMark = new Map<string, Mark>();
  const columnMarks = new Map<string, Record<string, Mark>>();
  const markColumn = (tableId: string, columnId: string, mark: Mark) => {
    const m = columnMarks.get(tableId) ?? {};
    m[columnId] = mark;
    columnMarks.set(tableId, m);
  };
  const touch = (tableId: string) => {
    if (!tableMark.has(tableId)) tableMark.set(tableId, 'changed');
  };
  const fkAdded = new Set<string>();
  const fkDropped = new Set<string>();

  for (const c of diff.changes) {
    switch (c.kind) {
      case 'createTable': tableMark.set(c.table.id, 'added'); break;
      case 'dropTable': tableMark.set(c.table.id, 'removed'); break;
      case 'addColumn': markColumn(c.table.id, c.column.id, 'added'); touch(c.table.id); break;
      case 'dropColumn': markColumn(c.table.id, c.column.id, 'removed'); touch(c.table.id); break;
      case 'alterColumn': markColumn(c.table.id, c.after.id, 'changed'); touch(c.table.id); break;
      case 'renameTable': case 'primaryKey': touch(c.after.id); break;
      case 'tableComment': case 'addIndex': case 'dropIndex': touch(c.table.id); break;
      case 'addForeignKey': fkAdded.add(c.relation.id); break;
      case 'dropForeignKey': fkDropped.add(c.relation.id); break;
    }
  }

  const baseTables = new Map(base.tables.map((t) => [t.id, t]));
  const tables: Table[] = target.tables.map((t) => {
    const old = baseTables.get(t.id);
    const removed = old?.columns.filter((c) => columnMarks.get(t.id)?.[c.id] === 'removed') ?? [];
    if (!removed.length || !old) return t;
    // 사라진 컬럼을 이전 순서대로 끼워 넣는다
    const columns = [...t.columns];
    for (const col of removed) {
      const before = old.columns[old.columns.indexOf(col) - 1];
      const at = before ? columns.findIndex((c) => c.id === before.id) + 1 : 0;
      columns.splice(at, 0, col);
    }
    return { ...t, columns };
  });
  for (const t of base.tables) if (tableMark.get(t.id) === 'removed') tables.push(t);

  const merged: Schema = { tables, relations: [...target.relations, ...base.relations.filter((r) => fkDropped.has(r.id) && !target.relations.some((x) => x.id === r.id))] };
  const nodes: TableNodeType[] = tables.map((table) => ({
    id: table.id,
    type: 'table',
    position: table.position,
    measured: measured.get(table.id),
    draggable: false,
    data: { table, fkIds: [...foreignKeyColumnIds(merged, table.id)], viewMode, highlight: tableMark.get(table.id), columnMarks: columnMarks.get(table.id) },
  }));
  const edges: RelationEdgeType[] = merged.relations.map((r) => ({
    id: r.id,
    type: 'relation',
    source: r.toTableId,
    target: r.fromTableId,
    data: {
      cardinality: r.cardinality,
      highlight: fkAdded.has(r.id) && fkDropped.has(r.id) ? 'changed' : fkAdded.has(r.id) ? 'added' : fkDropped.has(r.id) ? 'removed' : undefined,
    },
  }));
  return { nodes, edges, diff };
}

/** 새 테이블 자리: 원하는 곳(p)이 다른 테이블과 겹치면 가까운 빈 곳을 찾는다 (테이블 크기는 컬럼 수로 어림) */
export function freeSpot(schema: Schema, p: { x: number; y: number }): { x: number; y: number } {
  const W = 260;
  const box = (t: Table) => ({ x: t.position.x, y: t.position.y, w: W, h: 56 + 22 * t.columns.length });
  const boxes = schema.tables.map(box);
  const fits = (x: number, y: number) => boxes.every((b) => x + W + 20 <= b.x || b.x + b.w + 20 <= x || y + 140 <= b.y || b.y + b.h + 20 <= y);
  // 가까운 곳부터: 아래 → 위 → 오른쪽 → 왼쪽 → 대각선 순으로 한 칸씩 넓혀 간다 (화면 가운데에서 덜 벗어나게)
  const DIRS = [[0, 1], [0, -1], [1, 0], [-1, 0], [1, 1], [-1, 1], [1, -1], [-1, -1]];
  if (fits(p.x, p.y)) return p;
  for (let ring = 1; ring <= 6; ring++) {
    for (const [dx, dy] of DIRS) {
      const x = p.x + dx * ring * (W + 40);
      const y = p.y + dy * ring * 180;
      if (fits(x, y)) return { x, y };
    }
  }
  return p;
}
