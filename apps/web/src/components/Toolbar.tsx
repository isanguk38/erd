import { useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import { addTable, dialectList, type DialectId } from '@erd/core';
import { useStore, type RelationTool, type ViewMode } from '../store';
import { exportDiagram } from '../lib/exportImage';
import { downloadDataUrl, safeFileName } from '../lib/download';
import { sampleSchema } from '../lib/sample';

export type DialogName = 'sql' | 'versions' | 'import' | 'definition';

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

export function Toolbar({ onOpen }: { onOpen: (dialog: DialogName) => void }) {
  const projectName = useStore((s) => s.projectName);
  const dialect = useStore((s) => s.dialect);
  const viewMode = useStore((s) => s.viewMode);
  const relationTool = useStore((s) => s.relationTool);
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const isEmpty = useStore((s) => s.schema.tables.length === 0);
  const { setProjectName, setDialect, setViewMode, setRelationTool, edit, select, undo, redo, replaceSchema } = useStore.getState();
  const { getNodes, getNodesBounds, screenToFlowPosition, fitView } = useReactFlow();
  const [exporting, setExporting] = useState(false);

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
      <input className="project-name" value={projectName} onChange={(e) => setProjectName(e.target.value)} aria-label="프로젝트 이름" />
      <select value={dialect} onChange={(e) => setDialect(e.target.value as DialectId)} title="이 프로젝트의 DB 종류">
        {dialectList.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
      </select>
      <span className="divider" />
      <button
        className="btn btn-primary"
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
      <button className="icon-btn" title="되돌리기 (Ctrl+Z)" disabled={!canUndo} onClick={undo}>↶</button>
      <button className="icon-btn" title="다시 실행 (Ctrl+Y)" disabled={!canRedo} onClick={redo}>↷</button>
      {isEmpty && (
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
      <button className="btn" onClick={() => onOpen('import')}>SQL 가져오기</button>
      <button className="btn" onClick={() => onOpen('versions')}>버전</button>
      <button className="btn" onClick={() => onOpen('sql')}>SQL 추출</button>
      <button className="btn" disabled={isEmpty} onClick={() => onOpen('definition')}>정의서</button>
      <button className="btn" disabled={exporting} onClick={() => exportImage('png')}>PNG</button>
      <button className="btn" disabled={exporting} onClick={() => exportImage('svg')}>SVG</button>
    </header>
  );
}
