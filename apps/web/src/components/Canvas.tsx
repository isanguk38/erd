import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  applyNodeChanges,
  Background,
  ViewportPortal,
  ConnectionMode,
  Controls,
  MiniMap,
  ReactFlow,
  useReactFlow,
  type Connection,
  type NodeChange,
} from '@xyflow/react';
import { addTable, connectManyToMany, connectTables, removeRelation, removeTable } from '@erd/core';
import { useStore } from '../store';
import { TableNode, type TableNodeType } from './TableNode';
import { RelationEdge } from './RelationEdge';
import { buildCompareGraph, buildEdges, buildNodes } from '../lib/graph';
import { getDialect, type DialectId } from '@erd/core';

const nodeTypes = { table: TableNode };
const edgeTypes = { relation: RelationEdge };

/** fitRequest가 바뀌면 전체가 보이게 화면을 맞춘다 (가져오기 직후 등) */
export function Canvas({ fitRequest = 0 }: { fitRequest?: number }) {
  const schema = useStore((s) => s.schema);
  const viewMode = useStore((s) => s.viewMode);
  const selection = useStore((s) => s.selection);
  const peers = useStore((s) => s.peers);
  const compare = useStore((s) => s.compare);
  const dialectId = useStore((s) => s.meta.dialect);
  const synced = useStore((s) => s.synced);
  const { edit, select, setCursor } = useStore.getState();
  const { screenToFlowPosition, fitView } = useReactFlow();
  useEffect(() => {
    if (fitRequest) setTimeout(() => fitView({ padding: 0.15, duration: 300 }), 80);
  }, [fitRequest, fitView]);
  // 서버 문서를 처음 받으면 전체가 보이게 맞춘다
  useEffect(() => {
    if (synced) setTimeout(() => fitView({ padding: 0.15 }), 60);
  }, [synced, fitView]);
  const lastCursor = useRef(0);

  const selectedTable = selection?.type === 'table' ? selection.id : null;
  const selectedRelation = selection?.type === 'relation' ? selection.id : null;

  const [nodes, setNodes] = useState<TableNodeType[]>(() => buildNodes(schema, viewMode, selectedTable));
  const compareGraph = useMemo(
    () => (compare ? buildCompareGraph(compare.schema, schema, getDialect((dialectId || 'mysql') as DialectId), viewMode) : null),
    [compare, schema, dialectId, viewMode],
  );
  useEffect(() => {
    setNodes((prev) => {
      if (compareGraph) {
        const measured = new Map(prev.map((n) => [n.id, n.measured]));
        return compareGraph.nodes.map((n) => ({ ...n, measured: measured.get(n.id) }));
      }
      return buildNodes(schema, viewMode, selectedTable, prev, peers);
    });
  }, [schema, viewMode, selectedTable, peers, compareGraph]);
  const edges = useMemo(() => compareGraph?.edges ?? buildEdges(schema, selectedRelation), [compareGraph, schema, selectedRelation]);
  const readOnly = Boolean(compare);

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
      onConnect={readOnly ? undefined : onConnect}
      nodesDraggable={!readOnly}
      nodesConnectable={!readOnly}
      connectionMode={ConnectionMode.Loose}
      onNodeClick={(_, node) => select({ type: 'table', id: node.id })}
      onEdgeClick={(_, edge) => select({ type: 'relation', id: edge.id })}
      onPaneClick={() => select(null)}
      onMouseMove={(e) => {
        // 다른 사람에게 내 커서 위치를 알린다 (초당 20번까지)
        const now = Date.now();
        if (now - lastCursor.current < 50) return;
        lastCursor.current = now;
        const p = screenToFlowPosition({ x: e.clientX, y: e.clientY });
        setCursor({ x: Math.round(p.x), y: Math.round(p.y) });
      }}
      onMouseLeave={() => setCursor(null)}
      onNodeDragStop={(_, __, dragged) => {
        const moved = new Map(dragged.map((n) => [n.id, n.position]));
        edit((draft) => {
          for (const t of draft.tables) {
            const p = moved.get(t.id);
            if (p) t.position = { x: Math.round(p.x), y: Math.round(p.y) };
          }
        });
      }}
      onDoubleClick={(e) => {
        if (readOnly || !(e.target as HTMLElement).classList.contains('react-flow__pane')) return;
        const position = screenToFlowPosition({ x: e.clientX, y: e.clientY });
        edit((draft) => {
          const table = addTable(draft, { position });
          select({ type: 'table', id: table.id });
        });
      }}
      onNodesDelete={(deleted) => edit((draft) => deleted.forEach((n) => removeTable(draft, n.id)))}
      onEdgesDelete={(deleted) => edit((draft) => deleted.forEach((e) => removeRelation(draft, e.id)))}
      deleteKeyCode={readOnly ? null : ['Delete']}
      zoomOnDoubleClick={false}
      minZoom={0.1}
      maxZoom={2}
      fitView
      proOptions={{ hideAttribution: true }}
    >
      <Background gap={20} size={1} />
      <Controls showInteractive={false} />
      <MiniMap pannable zoomable nodeStrokeWidth={3} />
      <ViewportPortal>
        {peers.filter((p) => p.cursor).map((p) => (
          <div key={p.clientId} className="peer-cursor" style={{ transform: `translate(${p.cursor!.x}px, ${p.cursor!.y}px)`, color: p.color }}>
            <svg width="16" height="16" viewBox="0 0 16 16"><path d="M1 1 L1 13 L4.5 9.5 L7 15 L9 14 L6.5 8.5 L11.5 8.5 Z" fill="currentColor" stroke="white" strokeWidth="1" /></svg>
            <span style={{ background: p.color }}>{p.name}</span>
          </div>
        ))}
      </ViewportPortal>
    </ReactFlow>
  );
}
