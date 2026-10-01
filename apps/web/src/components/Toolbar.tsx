import { useEffect, useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import { addTable, dialectList, type DialectId } from '@erd/core';
import { useStore, type RelationTool, type ViewMode } from '../store';
import { exportDiagram } from '../lib/exportImage';
import { downloadDataUrl, safeFileName } from '../lib/download';
import { useDialect, useProjectName } from '../lib/hooks';
import { sampleSchema } from '../lib/sample';

export type DialogName = 'sql' | 'versions' | 'dbPull' | 'dbPush' | 'definition' | 'ai' | 'proposals';

const VIEW_MODES: { id: ViewMode; label: string }[] = [
  { id: 'physical', label: '물리명' },
  { id: 'logical', label: '논리명' },
  { id: 'both', label: '둘 다' },
];

const RELATION_TOOLS: { id: RelationTool; label: string }[] = [
  { id: '1:N', label: '1:N 비식별' },
  { id: '1:N-identifying', label: '1:N 식별' },
  { id: '1:1', label: '1:1' },
  { id: 'N:M', label: 'N:M (연결 테이블)' },
];

const STATUS_LABEL = { connected: '실시간 연결됨', connecting: '연결 중…', disconnected: '연결 끊김 (다시 연결 중)' };

function ProjectNameInput() {
  const name = useProjectName();
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft !== null && draft.trim() && draft !== name) useStore.getState().setProjectName(draft.trim());
    setDraft(null);
  };
  return (
    <input
      className="project-name"
      value={draft ?? name}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      aria-label="프로젝트 이름"
    />
  );
}

function Participants() {
  const peers = useStore((s) => s.peers);
  const status = useStore((s) => s.status);
  const userName = useStore((s) => s.userName);
  const userColor = useStore((s) => s.userColor);
  return (
    <div className="participants">
      <span className={`status-dot status-${status}`} title={STATUS_LABEL[status]} />
      <span className="avatar" style={{ background: userColor }} title={`나 (${userName || '이름 없음'})`}>
        {(userName || '나').slice(0, 1)}
      </span>
      {peers.map((p) => (
        <span key={p.clientId} className="avatar" style={{ background: p.color }} title={p.name}>
          {p.name.slice(0, 1)}
        </span>
      ))}
    </div>
  );
}

export function Toolbar({ onOpen }: { onOpen: (dialog: DialogName) => void }) {
  const projectName = useProjectName();
  const dialect = useDialect();
  const viewMode = useStore((s) => s.viewMode);
  const relationTool = useStore((s) => s.relationTool);
  const canUndo = useStore((s) => s.canUndo);
  const canRedo = useStore((s) => s.canRedo);
  const synced = useStore((s) => s.synced);
  const isEmpty = useStore((s) => s.schema.tables.length === 0);
  const pendingProposals = useStore((s) => s.meta.pendingProposals ?? 0);
  const { setDialect, setViewMode, setRelationTool, edit, select, undo, redo, replaceSchema } = useStore.getState();
  const { getNodes, getNodesBounds, screenToFlowPosition, fitView } = useReactFlow();
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    document.title = `${projectName} · ERD`;
  }, [projectName]);

  const arrange = async () => {
    const { autoLayout } = await import('@erd/core/layout');
    const positions = await autoLayout(useStore.getState().schema);
    edit((d) => {
      for (const t of d.tables) t.position = positions.get(t.id) ?? t.position;
    });
    setTimeout(() => fitView({ padding: 0.15, duration: 300 }), 50);
  };

  const exportImage = async (format: 'png' | 'svg') => {
    setExporting(true);
    try {
      const url = await exportDiagram(getNodes(), getNodesBounds, format);
      downloadDataUrl(url, `${safeFileName(projectName)}.${format}`);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(false);
    }
  };

  return (
    <header className="toolbar">
      <a className="icon-btn back" href="#/" title="프로젝트 목록">←</a>
      <ProjectNameInput />
      <select value={dialect} disabled={!synced} onChange={(e) => setDialect(e.target.value as DialectId)} title="이 프로젝트의 DB 종류">
        {dialectList.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
      </select>
      <Participants />
      <span className="divider" />
      <button
        className="btn btn-primary"
        disabled={!synced}
        onClick={() => {
          const center = screenToFlowPosition({ x: window.innerWidth / 2 - 200, y: window.innerHeight / 2 });
          edit((d) => {
            const t = addTable(d, { position: { x: Math.round(center.x), y: Math.round(center.y) } });
            select({ type: 'table', id: t.id });
          });
        }}
      >
        + 테이블
      </button>
      <select value={relationTool} onChange={(e) => setRelationTool(e.target.value as RelationTool)} title="테이블 점을 끌어 관계를 만들 때의 종류">
        {RELATION_TOOLS.map((t) => <option key={t.id} value={t.id}>관계: {t.label}</option>)}
      </select>
      <div className="segmented">
        {VIEW_MODES.map((m) => (
          <button key={m.id} className={viewMode === m.id ? 'active' : ''} onClick={() => setViewMode(m.id)}>{m.label}</button>
        ))}
      </div>
      <button className="btn" disabled={isEmpty} onClick={arrange} title="관계를 보고 테이블을 자동으로 배치합니다">자동 정렬</button>
      <button className="icon-btn" title="되돌리기 (Ctrl+Z) · 내가 한 변경만" disabled={!canUndo} onClick={undo}>↶</button>
      <button className="icon-btn" title="다시 실행 (Ctrl+Y)" disabled={!canRedo} onClick={redo}>↷</button>
      {isEmpty && synced && (
        <button
          className="btn"
          onClick={() => {
            replaceSchema(sampleSchema());
            setTimeout(() => fitView({ padding: 0.2 }), 50);
          }}
        >
          예제 불러오기
        </button>
      )}
      <span className="spacer" />
      <button className="btn" onClick={() => onOpen('dbPull')} title="연결한 DB의 구조를 읽어 ERD를 만들거나 갱신합니다">DB에서 가져오기</button>
      <button className="btn btn-primary" disabled={isEmpty} onClick={() => onOpen('dbPush')} title="ERD와 DB를 비교해 바뀐 부분만 DB에 실행합니다">DB로 내보내기</button>
      <span className="divider" />
      <button className="btn" onClick={() => onOpen('versions')}>버전</button>
      <button className="btn" onClick={() => onOpen('sql')}>SQL 추출</button>
      <button className="btn" disabled={isEmpty} onClick={() => onOpen('definition')}>정의서</button>
      <button className="btn" disabled={exporting} onClick={() => exportImage('png')}>PNG</button>
      <button className="btn" disabled={exporting} onClick={() => exportImage('svg')}>SVG</button>
      <button className={`btn btn-ai${pendingProposals ? ' has-badge' : ''}`} onClick={() => onOpen(pendingProposals ? 'proposals' : 'ai')} title="AI(MCP) 연결과 제안">
        AI{pendingProposals ? <span className="badge-count">{pendingProposals}</span> : null}
      </button>
    </header>
  );
}
