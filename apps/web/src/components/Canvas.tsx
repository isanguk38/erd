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
import { connectManyToMany, connectTables, removeRelation, removeTable } from '@erd/core';
import { useStore } from '../store';
import { TableNode } from './TableNode';
import { RelationEdge } from './RelationEdge';
import { buildCompareGraph, buildEdges, buildNodes } from '../lib/graph';
import type { TableNodeType } from './TableNode';
import { matchIds } from '../lib/search';
import { addTableWithTemplate } from '../lib/templates';
import { getDialect, type DialectId } from '@erd/core';
import { useTheme } from '../lib/theme';

const nodeTypes = { table: TableNode };
const edgeTypes = { relation: RelationEdge };

const sameIds = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id) => b.includes(id));

/** fitRequest가 바뀌면 전체가 보이게 화면을 맞춘다 (가져오기 직후 등) */
export function Canvas({ fitRequest = 0 }: { fitRequest?: number }) {
  const schema = useStore((s) => s.schema);
  const viewMode = useStore((s) => s.viewMode);
  const selection = useStore((s) => s.selection);
  const selectedTables = useStore((s) => s.selectedTables);
  const peers = useStore((s) => s.peers);
  const remoteChanges = useStore((s) => s.remoteChanges);
  const comments = useStore((s) => s.comments);
  // 테이블별 열린 댓글 수
  const commentMarks = useMemo(() => {
    const m = new Map<string, { open: number; review: number; columnIds: Set<string> }>();
    for (const c of comments) {
      if (c.status !== 'open') continue;
      const e = m.get(c.tableId) ?? { open: 0, review: 0, columnIds: new Set<string>() };
      e.open++;
      if (c.kind === 'review') e.review++;
      if (c.columnId) e.columnIds.add(c.columnId);
      m.set(c.tableId, e);
    }
    return m;
  }, [comments]);
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
  const selectedIds = useMemo(() => new Set(selectedTables), [selectedTables]);

  const [nodes, setNodes] = useState<TableNodeType[]>(() => buildNodes(schema, viewMode, selectedIds));
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
      return buildNodes(schema, viewMode, selectedIds, prev, peers, searchMarks, { remote: remoteChanges, comments: commentMarks });
    });
  }, [schema, viewMode, selectedIds, peers, compareGraph, searchMarks, remoteChanges, commentMarks]);
  const edges = useMemo(() => compareGraph?.edges ?? buildEdges(schema, selectedRelation), [compareGraph, schema, selectedRelation]);
  const role = useStore((s) => s.role);
  const readOnly = Boolean(compare) || role === 'viewer';
  const { effective: theme } = useTheme();

  const onNodesChange = useCallback((changes: NodeChange<TableNodeType>[]) => {
    setNodes((prev) => applyNodeChanges(changes, prev));
  }, []);

  // 캔버스에서 고른 것(클릭, Ctrl+클릭, Shift+드래그 상자)을 스토어에 알린다
  const onSelectionChange = useCallback(({ nodes: picked }: OnSelectionChangeParams) => {
    const tables = picked.map((n) => n.id);
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
        if (e.ctrlKey || e.metaKey || e.shiftKey) return;
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
          const table = addTableWithTemplate(draft, { position });
          select({ type: 'table', id: table.id });
        });
      }}
      onNodesDelete={(deleted) => edit((draft) => deleted.forEach((n) => removeTable(draft, n.id)))}
      onEdgesDelete={(deleted) => edit((draft) => deleted.forEach((e) => removeRelation(draft, e.id)))}
      deleteKeyCode={readOnly ? null : ['Delete']}
      multiSelectionKeyCode={['Control', 'Meta']}
      selectionKeyCode="Shift"
      zoomOnDoubleClick={false}
      minZoom={0.1}
      maxZoom={2}
      fitView
      proOptions={{ hideAttribution: true }}
      colorMode={theme}
    >
      <Background gap={20} size={1} />
      <Controls showInteractive={false} />
      <MiniMap pannable zoomable nodeStrokeWidth={3} nodeColor={theme === 'dark' ? '#475569' : '#cbd5e1'} />
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
