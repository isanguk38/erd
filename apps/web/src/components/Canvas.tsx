import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  applyNodeChanges,
  Background,
  ConnectionMode,
  Controls,
  MiniMap,
  ReactFlow,
  useReactFlow,
  type Connection,
  type NodeChange,
} from '@xyflow/react';
import { addTable, connectManyToMany, connectTables, foreignKeyColumnIds, removeRelation, removeTable, type Schema } from '@erd/core';
import { useStore } from '../store';
import { TableNode, type TableNodeType } from './TableNode';
import { RelationEdge, type RelationEdgeType } from './RelationEdge';

const nodeTypes = { table: TableNode };
const edgeTypes = { relation: RelationEdge };

export function buildNodes(schema: Schema, viewMode: ReturnType<typeof useStore.getState>['viewMode'], selectedId: string | null, prev: TableNodeType[] = []): TableNodeType[] {
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

export function Canvas() {
  const schema = useStore((s) => s.schema);
  const viewMode = useStore((s) => s.viewMode);
  const selection = useStore((s) => s.selection);
  const { edit, editSilently, select } = useStore.getState();
  const { screenToFlowPosition } = useReactFlow();

  const selectedTable = selection?.type === 'table' ? selection.id : null;
  const selectedRelation = selection?.type === 'relation' ? selection.id : null;

  const [nodes, setNodes] = useState<TableNodeType[]>(() => buildNodes(schema, viewMode, selectedTable));
  useEffect(() => {
    setNodes((prev) => buildNodes(schema, viewMode, selectedTable, prev));
  }, [schema, viewMode, selectedTable]);
  const edges = useMemo(() => buildEdges(schema, selectedRelation), [schema, selectedRelation]);

  const onNodesChange = useCallback((changes: NodeChange<TableNodeType>[]) => {
    // 선택은 스토어가 관리하므로 select 변경은 무시한다.
    setNodes((prev) => applyNodeChanges(changes.filter((c) => c.type !== 'select'), prev));
  }, []);

  const onConnect = useCallback(
    ({ source, target }: Connection) => {
      const tool = useStore.getState().relationTool;
      edit((draft) => {
        if (tool === 'N:M') {
          const { table } = connectManyToMany(draft, source, target);
          select({ type: 'table', id: table.id });
          return;
        }
        const relation = connectTables(draft, {
          parentTableId: source,
          childTableId: target,
          cardinality: tool === '1:1' ? '1:1' : '1:N',
          identifying: tool === '1:N-identifying',
        });
        select({ type: 'relation', id: relation.id });
      });
    },
    [edit, select],
  );

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodesChange={onNodesChange}
      onConnect={onConnect}
      connectionMode={ConnectionMode.Loose}
      onNodeClick={(_, node) => select({ type: 'table', id: node.id })}
      onEdgeClick={(_, edge) => select({ type: 'relation', id: edge.id })}
      onPaneClick={() => select(null)}
      onNodeDragStart={() => edit(() => {})}
      onNodeDragStop={(_, __, dragged) => {
        const moved = new Map(dragged.map((n) => [n.id, n.position]));
        editSilently((draft) => {
          for (const t of draft.tables) {
            const p = moved.get(t.id);
            if (p) t.position = { x: Math.round(p.x), y: Math.round(p.y) };
          }
        });
      }}
      onDoubleClick={(e) => {
        if (!(e.target as HTMLElement).classList.contains('react-flow__pane')) return;
        const position = screenToFlowPosition({ x: e.clientX, y: e.clientY });
        edit((draft) => {
          const table = addTable(draft, { position });
          select({ type: 'table', id: table.id });
        });
      }}
      onNodesDelete={(deleted) => edit((draft) => deleted.forEach((n) => removeTable(draft, n.id)))}
      onEdgesDelete={(deleted) => edit((draft) => deleted.forEach((e) => removeRelation(draft, e.id)))}
      deleteKeyCode={['Delete']}
      zoomOnDoubleClick={false}
      minZoom={0.1}
      maxZoom={2}
      fitView
      proOptions={{ hideAttribution: true }}
    >
      <Background gap={20} size={1} />
      <Controls showInteractive={false} />
      <MiniMap pannable zoomable nodeStrokeWidth={3} />
    </ReactFlow>
  );
}
