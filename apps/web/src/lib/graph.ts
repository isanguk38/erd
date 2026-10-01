import { foreignKeyColumnIds, type Schema } from '@erd/core';
import type { Peer, ViewMode } from '../store';
import type { TableNodeType } from '../components/TableNode';
import type { RelationEdgeType } from '../components/RelationEdge';

/** 스키마 → React Flow 노드. 이전 노드의 측정 크기는 유지한다 (관계선 계산에 필요). */
export function buildNodes(schema: Schema, viewMode: ViewMode, selectedId: string | null, prev: TableNodeType[] = [], peers: Peer[] = []): TableNodeType[] {
  const measured = new Map(prev.map((n) => [n.id, n.measured]));
  const peerMarks = (tableId: string) =>
    peers.filter((p) => p.selection?.type === 'table' && p.selection.id === tableId).map((p) => ({ name: p.name, color: p.color }));
  return schema.tables.map((table) => ({
    id: table.id,
    type: 'table',
    position: table.position,
    selected: table.id === selectedId,
    measured: measured.get(table.id),
    data: { table, fkIds: [...foreignKeyColumnIds(schema, table.id)], viewMode, peers: peerMarks(table.id) },
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

