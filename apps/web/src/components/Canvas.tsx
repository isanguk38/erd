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
  type OnSelectionChangeParams,
} from '@xyflow/react';
import { assignAreas, connectManyToMany, connectTables, moveArea, removeArea, removeRelation, removeTable } from '@erd/core';
import { useStore } from '../store';
import { TableNode } from './TableNode';
import { AreaNode } from './AreaNode';
import { RelationEdge } from './RelationEdge';
import { buildAreaNodes, buildCompareGraph, buildEdges, buildNodes, type ErdNode } from '../lib/graph';
import { matchIds } from '../lib/search';
import { measuredSizeOf, setMeasuredSizes } from '../lib/sizes';
import { addTableWithTemplate } from '../lib/templates';
import { getDialect, type DialectId } from '@erd/core';

const nodeTypes = { table: TableNode, area: AreaNode };
const edgeTypes = { relation: RelationEdge };

const sameIds = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id) => b.includes(id));

/** fitRequest가 바뀌면 전체가 보이게 화면을 맞춘다 (가져오기 직후 등) */
export function Canvas({ fitRequest = 0 }: { fitRequest?: number }) {
  const schema = useStore((s) => s.schema);
  const viewMode = useStore((s) => s.viewMode);
  const selection = useStore((s) => s.selection);
  const selectedTables = useStore((s) => s.selectedTables);
  const peers = useStore((s) => s.peers);
  const compare = useStore((s) => s.compare);
  const searchOpen = useStore((s) => s.searchOpen);
  const searchQuery = useStore((s) => s.searchQuery);
  const searchFocus = useStore((s) => s.searchFocus);
  // 검색에서 고른 것은 잠깐(2.5초) 강조한다
  const [focus, setFocus] = useState<typeof searchFocus>(null);
  useEffect(() => {
    setFocus(searchFocus);
    if (!searchFocus) return;
    const t = setTimeout(() => setFocus(null), 2500);
    return () => clearTimeout(t);
  }, [searchFocus]);
  const searchMarks = useMemo(() => {
    const q = searchOpen ? searchQuery.trim() : '';
    if (!q && !focus) return null;
    const ids = q ? matchIds(schema, q) : { tables: new Set(schema.tables.map((t) => t.id)), columns: new Set<string>() };
    return { ...ids, focus };
  }, [searchOpen, searchQuery, schema, focus]);
  const dialectId = useStore((s) => s.meta.dialect);
  const synced = useStore((s) => s.synced);
  const { edit, select, selectTables, setCursor } = useStore.getState();
  const { screenToFlowPosition, fitView } = useReactFlow();
  useEffect(() => {
    if (fitRequest) setTimeout(() => fitView({ padding: 0.15, duration: 300 }), 80);
  }, [fitRequest, fitView]);
  // 서버 문서를 처음 받으면 전체가 보이게 맞춘다
  useEffect(() => {
    if (synced) setTimeout(() => fitView({ padding: 0.15 }), 60);
  }, [synced, fitView]);
  const lastCursor = useRef(0);

  const selectedRelation = selection?.type === 'relation' ? selection.id : null;
  // 테이블 선택은 스토어가, 영역 선택은 캔버스가 맡는다 (같은 것을 두 곳에서 정하면 서로 덮어써 무한 반복된다)
  const selectedIds = useMemo(() => new Set(selectedTables), [selectedTables]);

  const [nodes, setNodes] = useState<ErdNode[]>(() => buildNodes(schema, viewMode, selectedIds));
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
      // 영역을 먼저 두어 테이블 뒤에 그려지게 한다
      return [...buildAreaNodes(schema, prev), ...buildNodes(schema, viewMode, selectedIds, prev, peers, searchMarks)];
    });
  }, [schema, viewMode, selectedIds, peers, compareGraph, searchMarks]);
  // 영역 소속을 정할 때 화면에서 잰 테이블 크기를 쓴다
  useEffect(() => {
    setMeasuredSizes(new Map(nodes.filter((n) => n.type === 'table' && n.measured?.width).map((n) => [n.id, { width: n.measured!.width!, height: n.measured!.height! }])));
  }, [nodes]);
  const edges = useMemo(() => compareGraph?.edges ?? buildEdges(schema, selectedRelation), [compareGraph, schema, selectedRelation]);
  const role = useStore((s) => s.role);
  const readOnly = Boolean(compare) || role === 'viewer';

  const onNodesChange = useCallback((changes: NodeChange<ErdNode>[]) => {
    setNodes((prev) => applyNodeChanges(changes, prev));
  }, []);

  // 캔버스에서 고른 것(클릭, Ctrl+클릭, Shift+드래그 상자)을 스토어에 알린다
  const onSelectionChange = useCallback(({ nodes: picked }: OnSelectionChangeParams) => {
    const tables = picked.filter((n) => n.type === 'table').map((n) => n.id);
    const state = useStore.getState();
    if (sameIds(state.selectedTables, tables)) return;
    if (tables.length === 0 && state.selection?.type === 'relation') return; // 관계를 고른 상태는 유지
    state.selectTables(tables);
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

  // 영역을 끄는 동안 안의 테이블도 같이 움직여 보이게 한다 (놓을 때 저장)
  const dragStart = useRef<Map<string, { x: number; y: number }>>(new Map());
  const onNodeDragStart = useCallback((_: unknown, __: unknown, dragged: ErdNode[]) => {
    dragStart.current = new Map(nodes.map((n) => [n.id, { ...n.position }]));
    void dragged;
  }, [nodes]);
  const onNodeDrag = useCallback((_: unknown, __: unknown, dragged: ErdNode[]) => {
    const draggedIds = new Set(dragged.map((n) => n.id));
    const follow = new Map<string, { x: number; y: number }>();
    for (const n of dragged) {
      if (n.type !== 'area') continue;
      const start = dragStart.current.get(n.id);
      if (!start) continue;
      const dx = n.position.x - start.x;
      const dy = n.position.y - start.y;
      for (const id of n.data.area.tableIds) {
        const s = dragStart.current.get(id);
        if (s && !draggedIds.has(id)) follow.set(id, { x: s.x + dx, y: s.y + dy });
      }
    }
    if (follow.size) setNodes((prev) => prev.map((n) => (follow.has(n.id) ? { ...n, position: follow.get(n.id)! } : n)));
  }, []);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodesChange={onNodesChange}
      onSelectionChange={onSelectionChange}
      onConnect={readOnly ? undefined : onConnect}
      nodesDraggable={!readOnly}
      nodesConnectable={!readOnly}
      connectionMode={ConnectionMode.Loose}
      onNodeClick={(e, node) => {
        // Ctrl/Shift를 누르고 클릭하면 여러 개 고르기 (캔버스가 처리)
        if (e.ctrlKey || e.metaKey || e.shiftKey || node.type !== 'table') return;
        select({ type: 'table', id: node.id });
      }}
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
      onNodeDragStart={onNodeDragStart}
      onNodeDrag={onNodeDrag}
      onNodeDragStop={(_, __, dragged) => {
        edit((draft) => {
          // 1) 영역을 옮겼으면 안의 테이블도 같은 만큼 (같이 끈 테이블은 영역이 옮긴다)
          const movedByArea = new Set<string>();
          for (const n of dragged) {
            if (n.type !== 'area') continue;
            moveArea(draft, n.id, { x: Math.round(n.position.x), y: Math.round(n.position.y) });
            for (const id of n.data.area.tableIds) movedByArea.add(id);
          }
          // 2) 테이블
          const moved: string[] = [];
          for (const n of dragged) {
            if (n.type !== 'table' || movedByArea.has(n.id)) continue;
            const t = draft.tables.find((x) => x.id === n.id);
            if (t) t.position = { x: Math.round(n.position.x), y: Math.round(n.position.y) };
            moved.push(n.id);
          }
          // 3) 옮긴 테이블이 어느 영역에 들어갔는지
          if (moved.length) assignAreas(draft, moved, measuredSizeOf());
        });
      }}
      onDoubleClick={(e) => {
        if (readOnly || !(e.target as HTMLElement).classList.contains('react-flow__pane')) return;
        const position = screenToFlowPosition({ x: e.clientX, y: e.clientY });
        edit((draft) => {
          const table = addTableWithTemplate(draft, { position });
          select({ type: 'table', id: table.id });
        });
      }}
      onNodesDelete={(deleted) =>
        edit((draft) =>
          deleted.forEach((n) => {
            if (n.type === 'area') removeArea(draft, n.id);
            else removeTable(draft, n.id);
          }),
        )
      }
      onEdgesDelete={(deleted) => edit((draft) => deleted.forEach((e) => removeRelation(draft, e.id)))}
      deleteKeyCode={readOnly ? null : ['Delete']}
      multiSelectionKeyCode={['Control', 'Meta']}
      selectionKeyCode="Shift"
      zoomOnDoubleClick={false}
      minZoom={0.1}
      maxZoom={2}
      fitView
      proOptions={{ hideAttribution: true }}
    >
      <Background gap={20} size={1} />
      <Controls showInteractive={false} />
      <MiniMap pannable zoomable nodeStrokeWidth={3} nodeColor={(n) => (n.type === 'area' ? 'transparent' : '#cbd5e1')} />
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
