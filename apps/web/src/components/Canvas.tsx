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
import { connectManyToMany, connectTables, findSameRelation, removeRelation, removeTable } from '@erd/core';
import { useStore } from '../store';
import { TableNode } from './TableNode';
import { RelationEdge } from './RelationEdge';
import { ConnectionLine } from './ConnectionLine';
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
  const pointerDown = useRef(false);
  const pendingIds = useRef<string[] | null>(null); // 마우스를 놓을 때 스토어에 알릴 선택

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
      return buildNodes(schema, viewMode, pendingIds.current ? new Set(pendingIds.current) : selectedIds, prev, peers, searchMarks, { remote: remoteChanges, comments: commentMarks });
    });
  }, [schema, viewMode, selectedIds, peers, compareGraph, searchMarks, remoteChanges, commentMarks]);
  const edges = useMemo(() => compareGraph?.edges ?? buildEdges(schema, selectedRelation), [compareGraph, schema, selectedRelation]);
  const role = useStore((s) => s.role);
  const readOnly = Boolean(compare) || role === 'viewer';
  const { effective: theme } = useTheme();

  // 선택은 사용자가 캔버스에서 직접 바꾼 것(클릭, Ctrl+클릭, Shift+끌기 상자)만 스토어에 알린다.
  // onNodesChange의 select 변경은 사용자 조작일 때만 오고, 스토어가 바꾼 선택(검색 결과 클릭 등)으로는 오지 않는다.
  // (onSelectionChange는 스토어가 바꾼 선택에도 한 박자 늦게 불려 서로 덮어쓰며 무한 반복된 적이 있다)
  // 마우스 버튼을 누르고 있는 동안(테이블을 잡고 끄는 중)에는 선택을 스토어에 알리지 않고, 놓는 순간 알린다.
  // (편집 창이 열려 있을 때 잡자마자 내용이 바뀌면 아직 잡고 있는지 헷갈린다)
  const commitSelection = useCallback((ids: string[]) => {
    const state = useStore.getState();
    if (sameIds(state.selectedTables, ids)) return;
    if (ids.length === 0 && state.selection?.type === 'relation') return; // 관계를 고른 상태는 유지
    state.selectTables(ids);
  }, []);
  useEffect(() => {
    const down = (e: PointerEvent) => { if (e.button === 0) pointerDown.current = true; };
    const up = () => {
      pointerDown.current = false;
      const ids = pendingIds.current;
      pendingIds.current = null;
      if (ids) commitSelection(ids);
    };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
    window.addEventListener('blur', up);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
      window.removeEventListener('blur', up);
    };
  }, [commitSelection]);
  const onNodesChange = useCallback((changes: NodeChange<TableNodeType>[]) => {
    const picked = changes.some((c) => c.type === 'select');
    setNodes((prev) => {
      const next = applyNodeChanges(changes, prev);
      if (picked) {
        const ids = next.filter((n) => n.selected).map((n) => n.id);
        queueMicrotask(() => {
          if (pointerDown.current) pendingIds.current = ids;
          else commitSelection(ids);
        });
      }
      return next;
    });
  }, [commitSelection]);

  const onConnect = useCallback(
    ({ source, target }: Connection) => {
      const tool = useStore.getState().relationTool;
      // 이미 같은 관계(같은 FK 컬럼)가 있으면 또 만들지 않고 그 관계를 보여 준다
      const same = tool === 'N:M' ? undefined : findSameRelation(useStore.getState().schema, source, target);
      if (same) {
        select({ type: 'relation', id: same.id }, true);
        useStore.getState().showNotice({ text: '이미 같은 관계가 있습니다. 오른쪽에서 그 관계를 편집하세요.' });
        return;
      }
      edit((draft) => {
        if (tool === 'N:M') {
          const { table } = connectManyToMany(draft, source, target);
          select({ type: 'table', id: table.id }, true);
          return;
        }
        const relation = connectTables(draft, {
          parentTableId: source,
          childTableId: target,
          cardinality: tool === '1:1' ? '1:1' : '1:N',
          identifying: tool === '1:N-identifying',
        });
        select({ type: 'relation', id: relation.id }, true);
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
      connectionLineComponent={ConnectionLine}
      onNodeClick={(e, node) => {
        // Ctrl/Shift를 누르고 클릭하면 여러 개 고르기 (캔버스가 처리)
        if (e.ctrlKey || e.metaKey || e.shiftKey) return;
        select({ type: 'table', id: node.id });
      }}
      // 클릭·끌기는 고르기만 하고, 오른쪽 편집 창은 더블클릭할 때 연다 (옮기기만 했는데 창이 열리면 불편하다)
      onNodeDoubleClick={(_, node) => select({ type: 'table', id: node.id }, true)}
      onEdgeClick={(_, edge) => select({ type: 'relation', id: edge.id })}
      onEdgeDoubleClick={(_, edge) => select({ type: 'relation', id: edge.id }, true)}
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
          select({ type: 'table', id: table.id }, true);
        });
      }}
      onNodesDelete={(deleted) => edit((draft) => deleted.forEach((n) => removeTable(draft, n.id)))}
      onEdgesDelete={(deleted) => {
        // 관계를 지우면 그 FK 컬럼도 지운다 (다른 관계가 같이 쓰는 컬럼은 남김). Ctrl+Z로 함께 되돌린다
        const dropped: string[] = [];
        edit((draft) => deleted.forEach((e) => dropped.push(...removeRelation(draft, e.id, true))));
        if (dropped.length) useStore.getState().showNotice({ text: `관계와 FK 컬럼 ${dropped.join(', ')}을(를) 지웠습니다. (Ctrl+Z로 되돌리기)` });
      }}
      // 관계 연결 점을 클릭만 해서는 연결되지 않고, 10px 이상 끌어야 연결이 시작된다 (붙어 있는 테이블에서 실수로 관계가 생기지 않게)
      connectOnClick={false}
      connectionDragThreshold={10}
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
