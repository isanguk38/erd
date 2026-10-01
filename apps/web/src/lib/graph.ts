import { foreignKeyColumnIds, type Schema } from '@erd/core';
import type { ViewMode } from '../store';
import type { TableNodeType } from '../components/TableNode';
import type { RelationEdgeType } from '../components/RelationEdge';

/** 스키마 → React Flow 노드. 이전 노드의 측정 크기는 유지한다 (관계선 계산에 필요). */
export function buildNodes(schema: Schema, viewMode: ViewMode, selectedId: string | null, prev: TableNodeType[] = []): TableNodeType[] {
  const measured = new Map(prev.map((n) => [n.id, n.measured]));
  return schema.tables.map((table) => ({
    id: table.id,
    type: 'table',
    position: table.position,
    selected: table.id === selectedId,
    measured: measured.get(table.id),
    data: { table, fkIds: [...foreignKeyColumnIds(schema, table.id)], viewMode },
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

