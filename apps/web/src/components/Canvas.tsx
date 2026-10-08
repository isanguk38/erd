import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  applyNodeChanges,
  Background,
  ViewportPortal,
  ConnectionMode,
  Controls,
  MiniMap,
  ReactFlow,
  useNodesInitialized,
  useReactFlow,
  type Connection,
  type NodeChange,
} from '@xyflow/react';
import { addToArea, connectManyToMany, connectTables, findSameRelation, moveToArea, notesOf, removeFromArea, removeRelation, removeTable, setAreaPosition, tablesDeleteImpact } from '@erd/core';

/** 이만큼 움직이지 않고 누르고 있으면 영역으로 옮기기 모드 */
const LONG_PRESS_MS = 450;
import { useStore } from '../store';
import { TableNode } from './TableNode';
import { RelationEdge } from './RelationEdge';
import { ConnectionLine } from './ConnectionLine';
import { buildAreaView, buildCompareGraph, buildEdges, buildNodes, FIT_MAX_ZOOM } from '../lib/graph';
import { GhostNode, type GhostNodeType } from './GhostNode';
import { NoteNode, type NoteNodeType } from './NoteNode';
import { arrangeTables } from '../lib/arrange';
import type { TableNodeType } from './TableNode';
import { matchIds } from '../lib/search';
import { addTableWithTemplate } from '../lib/templates';
import { requestFocus } from '../lib/focus';
import { confirmImpact } from '../lib/impact';
import { getDialect, type DialectId } from '@erd/core';
import { useTheme } from '../lib/theme';

const nodeTypes = { table: TableNode, ghost: GhostNode, note: NoteNode };
type CanvasNode = TableNodeType | GhostNodeType | NoteNodeType;

/** 마우스·터치 이벤트의 화면 좌표 */
function pointOf(e: MouseEvent | TouchEvent): [number, number] {
  const t = 'changedTouches' in e ? e.changedTouches[0] : e;
  return [t?.clientX ?? 0, t?.clientY ?? 0];
}

/** 마우스 아래의 주제영역 탭 (테이블을 끌어 탭에 놓을 때). 전체 탭이면 '' */
function areaTabAt(x: number, y: number): { el: HTMLElement; areaId: string } | null {
  const el = document.elementsFromPoint(x, y).map((e) => (e as HTMLElement).closest?.('[data-area-tab]') as HTMLElement | null).find(Boolean);
  return el ? { el, areaId: el.dataset.areaTab ?? '' } : null;
}
const edgeTypes = { relation: RelationEdge };

const sameIds = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id) => b.includes(id));

/** fitRequest가 바뀌면 전체가 보이게 화면을 맞춘다 (가져오기 직후 등) */
export function Canvas({ fitRequest = 0, relayoutRequest = 0 }: { fitRequest?: number; relayoutRequest?: number }) {
  const schema = useStore((s) => s.schema);
  const viewMode = useStore((s) => s.viewMode);
  const selection = useStore((s) => s.selection);
  const selectedTables = useStore((s) => s.selectedTables);
  const peers = useStore((s) => s.peers);
  const remoteChanges = useStore((s) => s.remoteChanges);
  const comments = useStore((s) => s.comments);
  const notes = useStore((s) => s.notes);
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
  const { screenToFlowPosition, fitView, getViewport, setViewport, getNodes } = useReactFlow();
  // 편집 창이 열리며 캔버스가 좁아질 때, 고른 테이블·관계가 편집 창 뒤로 가려지면 보일 만큼만 화면을 옮긴다
  const inspectorOpen = useStore((s) => s.inspectorOpen);
  const selectedKey = selection ? `${selection.type}:${selection.id}` : '';
  useEffect(() => {
    if (!inspectorOpen || !selection) return;
    const timer = setTimeout(() => {
      const pane = document.querySelector('.react-flow')?.getBoundingClientRect();
      // 관계는 양쪽 테이블까지 함께 보이게
      const relation = selection.type === 'relation' ? useStore.getState().schema.relations.find((r) => r.id === selection.id) : null;
      const ids = relation ? [relation.fromTableId, relation.toTableId] : [selection.id];
      const rects = ids.flatMap((id) => {
        const r = document.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}"]`)?.getBoundingClientRect();
        return r ? [r] : [];
      });
      if (!pane || !rects.length) return;
      const el = { left: Math.min(...rects.map((r) => r.left)), right: Math.max(...rects.map((r) => r.right)), top: Math.min(...rects.map((r) => r.top)), bottom: Math.max(...rects.map((r) => r.bottom)) };
      const M = 24;
      const shift = (start: number, end: number, min: number, max: number) =>
        end - start > max - min - 2 * M ? start - (min + M) : end > max - M ? end - (max - M) : start < min + M ? start - (min + M) : 0;
      const dx = shift(el.left, el.right, pane.left, pane.right);
      // 오른쪽 아래 미니맵과 겹치면 미니맵 위까지만 쓴다
      const mini = document.querySelector('.react-flow__minimap')?.getBoundingClientRect();
      const bottom = mini && el.right - dx > mini.left ? mini.top : pane.bottom;
      const dy = shift(el.top, el.bottom, pane.top, bottom);
      if (!dx && !dy) return;
      const vp = getViewport();
      setViewport({ x: vp.x - dx, y: vp.y - dy, zoom: vp.zoom }, { duration: 250 });
    }, 80);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inspectorOpen, selectedKey]);
  // 버전 비교를 시작·끝내면 오른쪽 패널이 열리고 닫히므로, 남은 캔버스에 전체가 보이게 맞춘다
  const comparing = Boolean(compare);
  // 값이 실제로 바뀔 때만 (처음 그릴 때 맞추면 빈 캔버스에서는 첫 테이블이 생길 때까지 미뤄졌다가 그때 화면이 튄다)
  const prevComparing = useRef(comparing);
  useEffect(() => {
    if (prevComparing.current === comparing) return;
    prevComparing.current = comparing;
    const t = setTimeout(() => fitView({ padding: 0.15, duration: 300, maxZoom: FIT_MAX_ZOOM }), 120);
    return () => clearTimeout(t);
  }, [comparing, fitView]);
  useEffect(() => {
    if (fitRequest) setTimeout(() => fitView({ padding: 0.15, duration: 300, maxZoom: FIT_MAX_ZOOM }), 80);
  }, [fitRequest, fitView]);
  // 서버 문서를 처음 받으면 (테이블 크기를 잰 뒤) 전체가 보이게 한 번만 맞춘다.
  // 빈 ERD로 열었으면 맞추지 않는다 — 첫 테이블을 추가할 때 화면이 그 테이블로 옮겨 가 편집 창에 가리지 않게
  const nodesInitialized = useNodesInitialized();
  const fitted = useRef(false);
  useEffect(() => {
    if (!synced || fitted.current) return;
    if (!useStore.getState().schema.tables.length) {
      fitted.current = true;
      return;
    }
    if (!nodesInitialized) return;
    fitted.current = true;
    fitView({ padding: 0.15, maxZoom: FIT_MAX_ZOOM });
  }, [synced, nodesInitialized, fitView]);
  // 다시 정렬 요청(빈 ERD로 DB를 가져온 직후): 테이블을 다 그려 크기를 잰 뒤 실제 크기로 정렬해 겹치지 않게
  const relayoutPending = useRef(false);
  useEffect(() => {
    if (relayoutRequest) relayoutPending.current = true;
  }, [relayoutRequest]);
  useEffect(() => {
    if (!relayoutPending.current || !nodesInitialized) return;
    relayoutPending.current = false;
    void arrangeTables(getNodes()).then(() => setTimeout(() => fitView({ padding: 0.15, duration: 300, maxZoom: FIT_MAX_ZOOM }), 80));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relayoutRequest, nodesInitialized]);
  const lastCursor = useRef(0);
  const pointerDown = useRef(false);
  const pendingIds = useRef<string[] | null>(null); // 마우스를 놓을 때 스토어에 알릴 선택

  const selectedRelation = selection?.type === 'relation' ? selection.id : null;
  const selectedIds = useMemo(() => new Set(selectedTables), [selectedTables]);

  // 주제영역 탭: 그 영역 테이블(영역 위치) + 영역 밖과 이어진 테이블은 흐린 참조 카드 (버전 비교 중에는 전체)
  const activeArea = useStore((s) => s.activeArea);
  const noteReadOnly = useStore((s) => s.role === 'viewer');
  const [nodes, setNodes] = useState<CanvasNode[]>(() => buildNodes(schema, viewMode, selectedIds));
  // 화면에서 잰 테이블 크기 (참조 카드 자리·자동 정렬에 씀). 크기가 실제로 바뀔 때만 새 값
  const sizeKey = useMemo(
    () => nodes.filter((n) => n.type === 'table' && n.measured?.width).map((n) => `${n.id}:${Math.round(n.measured!.width!)}:${Math.round(n.measured!.height!)}`).join('|'),
    [nodes],
  );
  const measured = useMemo(
    () => new Map(sizeKey ? sizeKey.split('|').map((s) => { const [id, w, h] = s.split(':'); return [id, { width: Number(w), height: Number(h) }] as const; }) : []),
    [sizeKey],
  );
  const areaView = useMemo(() => (activeArea && !compare ? buildAreaView(schema, activeArea, measured) : null), [activeArea, compare, schema, measured]);
  const viewSchema = areaView?.schema ?? schema;
  // 탭에 놓았을 때처럼 저장하지 않고 원래 자리로 되돌릴 때 다시 그린다
  const [redraw, setRedraw] = useState(0);
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
      const tables = prev.filter((n): n is TableNodeType => n.type === 'table');
      // 메모: 지금 탭(전체 또는 이 영역)에 붙인 것. 테이블보다 먼저 넣어 테이블 아래에 그린다
      const prevNotes = new Map(prev.filter((n) => n.type === 'note').map((n) => [n.id, n]));
      const noteNodes: CanvasNode[] = notesOf(notes, areaView ? activeArea : null).map((note) => ({
        id: note.id,
        type: 'note',
        position: note.position,
        width: note.width,
        height: note.height,
        selected: prevNotes.get(note.id)?.selected,
        measured: prevNotes.get(note.id)?.measured,
        connectable: false,
        deletable: !noteReadOnly,
        data: { text: note.text, color: note.color, readOnly: noteReadOnly },
      }));
      const built: CanvasNode[] = [...noteNodes, ...buildNodes(viewSchema, viewMode, pendingIds.current ? new Set(pendingIds.current) : selectedIds, tables, peers, searchMarks, { remote: remoteChanges, comments: commentMarks })];
      const ghostMeasured = new Map(prev.filter((n) => n.type === 'ghost').map((n) => [n.id, n.measured]));
      for (const g of areaView?.ghosts ?? []) {
        built.push({
          id: g.id,
          type: 'ghost',
          position: g.position,
          draggable: false,
          selectable: false,
          deletable: false,
          connectable: false,
          measured: ghostMeasured.get(g.id),
          data: { name: g.name, logicalName: g.logicalName, areaNames: g.areaNames, viewMode },
        });
      }
      return built;
    });
  }, [viewSchema, areaView, viewMode, selectedIds, peers, compareGraph, searchMarks, remoteChanges, commentMarks, redraw, notes, noteReadOnly]);
  const edges = useMemo(
    () => compareGraph?.edges ?? buildEdges(viewSchema, selectedRelation, areaView?.ghostRelationIds),
    [compareGraph, viewSchema, selectedRelation, areaView],
  );
  // 탭을 바꾸면 그 영역이 보이게 맞춘다 (처음 그릴 때는 위의 한 번 맞추기가 한다)
  const prevArea = useRef(activeArea);
  useEffect(() => {
    if (prevArea.current === activeArea) return;
    prevArea.current = activeArea;
    const t = setTimeout(() => fitView({ padding: 0.15, duration: 250, maxZoom: FIT_MAX_ZOOM }), 60);
    return () => clearTimeout(t);
  }, [activeArea, fitView]);
  /** 참조 카드를 누르면: 그 테이블이 있는 영역(없으면 전체)으로 가서 그 테이블을 보여 준다 */
  const goToTable = (tableId: string) => {
    useStore.getState().revealTable(tableId);
    select({ type: 'table', id: tableId });
    setTimeout(() => fitView({ nodes: [{ id: tableId }], padding: 0.8, duration: 300, maxZoom: 1.2 }), 120);
  };
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
  const onNodesChange = useCallback((changes: NodeChange<CanvasNode>[]) => {
    const picked = changes.some((c) => c.type === 'select');
    setNodes((prev) => {
      const next = applyNodeChanges(changes, prev);
      if (picked) {
        // 메모는 캔버스에서만 고른다 (스토어의 선택은 테이블)
        const ids = next.filter((n) => n.selected && n.type === 'table').map((n) => n.id);
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

  // ── 영역으로 옮기기 모드: 테이블을 움직이지 않고 꾹 누르고 있으면(0.45초) 켜진다 ──────────
  // 고른 테이블만 또렷하고 나머지는 흐려지며, 끄는 동안 화면이 따라 움직이지 않는다(가장자리 자동 이동 끔).
  // 영역 탭에 놓으면 그 영역으로 옮기고, 다른 곳에 놓거나 Esc면 원래 자리로. 그냥 클릭해 끌면 평소처럼 위치만 옮긴다.
  const hasAreas = useStore((s) => Boolean(s.schema.areas?.length));
  const [picking, setPicking] = useState<{ ids: string[]; x: number; y: number } | null>(null);
  const pickingRef = useRef<{ ids: string[]; cancelled: boolean } | null>(null);
  useEffect(() => {
    if (readOnly || !hasAreas) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let start = { x: 0, y: 0 };
    const stop = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
    };
    const down = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      if (target.closest('.react-flow__handle')) return; // 관계 잇기 점
      const id = (target.closest('.react-flow__node-table') as HTMLElement | null)?.dataset.id;
      if (!id) return;
      start = { x: e.clientX, y: e.clientY };
      stop();
      timer = setTimeout(() => {
        timer = undefined;
        const state = useStore.getState();
        // 여러 개를 골라 둔 상태에서 그중 하나를 누르면 고른 것 전부
        const ids = state.selectedTables.length > 1 && state.selectedTables.includes(id) ? state.selectedTables : [id];
        if (!state.selectedTables.includes(id) || ids.length === 1) state.selectTables(ids);
        pickingRef.current = { ids, cancelled: false };
        setPicking({ ids, x: start.x, y: start.y });
      }, LONG_PRESS_MS);
    };
    const move = (e: PointerEvent) => {
      // 누른 채 움직이면 평소 끌기 (꾹 누르기 아님)
      if (timer && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 5) stop();
      if (pickingRef.current && !pickingRef.current.cancelled) setPicking((p) => (p ? { ...p, x: e.clientX, y: e.clientY } : p));
    };
    const up = () => {
      stop();
      // 끌기를 마치는 처리(onNodeDragStop)가 모드를 먼저 보도록 한 박자 뒤에 끈다
      setTimeout(() => {
        pickingRef.current = null;
        setPicking(null);
      }, 0);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !pickingRef.current) return;
      pickingRef.current.cancelled = true;
      setPicking(null);
    };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
    window.addEventListener('keydown', key);
    return () => {
      stop();
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
      window.removeEventListener('keydown', key);
    };
  }, [readOnly, hasAreas]);
  // 영역 탭들을 놓을 곳으로 표시
  useEffect(() => {
    document.body.classList.toggle('area-picking', Boolean(picking));
    return () => document.body.classList.remove('area-picking');
  }, [picking]);
  const clearDropMarks = () => document.querySelectorAll('.area-tab.drop-target').forEach((el) => el.classList.remove('drop-target'));

  return (
    <>
    <ReactFlow
      className={picking ? 'picking' : undefined}
      autoPanOnNodeDrag={!picking}
      // 영역 탭에서 Delete: 테이블은 지우지 않고 그 영역에서만 뺀다 (테이블 삭제는 전체 탭에서)
      onBeforeDelete={async ({ nodes: toDelete, edges: edgesToDelete }) => {
        // 메모는 따로 지운다 (스키마가 아님)
        const noteIds = toDelete.filter((n) => n.type === 'note').map((n) => n.id);
        if (noteIds.length) useStore.getState().removeNotes(noteIds);
        const tables = toDelete.filter((n) => n.type === 'table');
        if (!tables.length && !edgesToDelete.length) return false;
        const area = activeArea ? useStore.getState().schema.areas?.find((a) => a.id === activeArea) : undefined;
        if (!area || !tables.length) {
          // 영향도: 다른 테이블의 외래키까지 사라지면 확인한다
          const schemaNow = useStore.getState().schema;
          const impact = tablesDeleteImpact(schemaNow, tables.map((n) => n.id));
          if (impact.length) {
            const name = tables.length > 1 ? `테이블 ${tables.length}개` : schemaNow.tables.find((t) => t.id === tables[0].id)?.name;
            if (!confirmImpact(`${name}을(를) 지우면 다른 테이블도 바뀝니다:`, impact)) return false;
          }
          return { nodes: tables, edges: edgesToDelete };
        }
        const names = tables.map((n) => useStore.getState().schema.tables.find((t) => t.id === n.id)?.name ?? n.id);
        edit((d) => removeFromArea(d, area.id, tables.map((n) => n.id)));
        useStore.getState().showNotice({ text: `${names.join(', ')}을(를) ${area.name} 영역에서 뺐습니다. 테이블은 전체에 남아 있고, 삭제는 전체 탭에서 합니다 (Ctrl+Z로 되돌리기)` });
        return false;
      }}
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
        if (node.type === 'ghost') return goToTable(node.id);
        if (node.type !== 'table') return;
        // Ctrl/Shift를 누르고 클릭하면 여러 개 고르기 (캔버스가 처리)
        if (e.ctrlKey || e.metaKey || e.shiftKey) return;
        select({ type: 'table', id: node.id });
      }}
      // 클릭·끌기는 고르기만 하고, 오른쪽 편집 창은 더블클릭할 때 연다 (옮기기만 했는데 창이 열리면 불편하다)
      onNodeDoubleClick={(_, node) => node.type === 'table' && select({ type: 'table', id: node.id }, true)}
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
      // 옮기기 모드에서 끄는 동안 마우스가 주제영역 탭 위에 있으면 그 탭을 표시한다 (놓으면 그 영역으로 옮김)
      onNodeDrag={(e) => {
        if (!pickingRef.current || pickingRef.current.cancelled) return;
        const hit = areaTabAt(...pointOf(e));
        document.querySelectorAll('.area-tab.drop-target').forEach((el) => el !== hit?.el && el.classList.remove('drop-target'));
        if (hit && hit.areaId !== (activeArea ?? '')) hit.el.classList.add('drop-target');
      }}
      onNodeDragStop={(e, __, dragged) => {
        clearDropMarks();
        const ids = dragged.filter((n) => n.type === 'table').map((n) => n.id);
        // 옮기기 모드(꾹 누르기): 탭에 놓으면 지금 영역에서 그 영역으로 옮기고(전체 탭에서 끌었으면 그 영역에 넣고),
        // 위치는 저장하지 않는다. 탭이 아닌 곳에 놓거나 Esc면 원래 자리로
        const pick = pickingRef.current;
        if (pick) {
          const hit = pick.cancelled ? null : areaTabAt(...pointOf(e));
          if (!hit && !pick.cancelled) useStore.getState().showNotice({ text: '영역 탭에 놓으면 그 영역으로 옮겨집니다. 위치만 옮기려면 누르자마자 끌어 주세요' });
          if (!hit) {
            setRedraw((n) => n + 1);
            return;
          }
          const target = useStore.getState().schema.areas?.find((a) => a.id === hit.areaId);
          if (target && hit.areaId !== activeArea && ids.length) {
            edit((draft) => (activeArea ? moveToArea(draft, target.id, ids, activeArea) : void addToArea(draft, target.id, ids)));
            const names = ids.map((id) => useStore.getState().schema.tables.find((t) => t.id === id)?.name).join(', ');
            useStore.getState().showNotice({ text: `${names}을(를) ${activeArea ? '' : '전체에 둔 채 '}${target.name} 영역${activeArea ? '으로 옮겼습니다' : '에 넣었습니다'} (Ctrl+Z로 되돌리기)` });
          }
          setRedraw((n) => n + 1);
          return;
        }
        // 메모 위치
        for (const n of dragged) if (n.type === 'note') useStore.getState().updateNote(n.id, { position: n.position });
        if (!ids.length) return;
        const moved = new Map(dragged.map((n) => [n.id, n.position]));
        edit((draft) => {
          // 영역 탭에서 옮기면 그 영역에서의 위치만 바뀐다 (전체 ERD 배치는 그대로)
          if (activeArea && draft.areas?.some((a) => a.id === activeArea)) {
            for (const id of ids) setAreaPosition(draft, activeArea, id, moved.get(id)!);
            return;
          }
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
          // 영역 탭에서 만들면 그 영역에 (그 자리에) 넣는다
          if (activeArea && draft.areas?.some((a) => a.id === activeArea)) addToArea(draft, activeArea, [table.id], { [table.id]: position });
          requestFocus(`table:${table.id}`);
          select({ type: 'table', id: table.id }, true);
        });
      }}
      // Delete 키: 테이블과 관계를 한 번에 지운다 (Ctrl+Z 한 번으로 함께 되돌림).
      // 테이블을 지우면 거기 붙은 관계도 같이 넘어오는데, 그 관계는 테이블 삭제로만 처리한다 —
      // 편집 창의 삭제 버튼처럼 상대 테이블의 FK 컬럼은 남긴다. 관계만 골라 지울 때는 그 FK 컬럼도 지운다.
      onDelete={({ nodes: deletedNodes, edges: deletedEdges }) => {
        const tableIds = new Set(deletedNodes.map((n) => n.id));
        const relations = deletedEdges.filter((e) => !tableIds.has(e.source) && !tableIds.has(e.target));
        const dropped: string[] = [];
        edit((draft) => {
          relations.forEach((e) => dropped.push(...removeRelation(draft, e.id, true)));
          tableIds.forEach((id) => removeTable(draft, id));
        });
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
    {picking && (
      <div className="pick-chip" style={{ left: picking.x + 14, top: picking.y + 14 }}>
        <b>{picking.ids.map((id) => schema.tables.find((t) => t.id === id)?.name).join(', ')}</b> → 영역 탭에 놓으면 옮겨집니다 · Esc 취소
      </div>
    )}
    </>
  );
}
