import { useEffect, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { useStore } from './store';
import { Canvas } from './components/Canvas';
import { Inspector } from './components/Inspector';
import { Toolbar, type DialogName } from './components/Toolbar';
import { SqlDialog } from './components/SqlDialog';
import { VersionsDialog } from './components/VersionsDialog';
import { DbPullDialog } from './components/DbPullDialog';
import { DbPushDialog } from './components/DbPushDialog';
import { DefinitionDialog } from './components/DefinitionDialog';
import { AiBanner, AiDialog, ProposalsDialog } from './components/AiPanels';
import { ProjectsPage } from './components/ProjectsPage';
import { refreshDbStatus } from './lib/hooks';

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
}

/** 주소: #/ → 프로젝트 목록, #/p/<id> → 편집기 */
function useRoute(): string | null {
  const parse = () => location.hash.match(/^#\/p\/([a-zA-Z0-9-]+)/)?.[1] ?? null;
  const [projectId, setProjectId] = useState(parse);
  useEffect(() => {
    const onHash = () => setProjectId(parse());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return projectId;
}

export function App() {
  const projectId = useRoute();
  if (!projectId) return <ProjectsPage />;
  return <Editor key={projectId} projectId={projectId} />;
}

function Editor({ projectId }: { projectId: string }) {
  const [dialog, setDialog] = useState<DialogName | null>(null);
  const [fitRequest, setFitRequest] = useState(0);
  const synced = useStore((s) => s.synced);
  const status = useStore((s) => s.status);

  useEffect(() => {
    useStore.getState().open(projectId);
    return () => useStore.getState().close();
  }, [projectId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || !(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault();
        useStore.getState().undo();
      } else if (key === 'y' || (key === 'z' && e.shiftKey)) {
        e.preventDefault();
        useStore.getState().redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const close = () => {
    // DB 가져오기·내보내기 뒤에는 차이 알림을 바로 다시 확인한다
    if (dialog === 'dbPull' || dialog === 'dbPush') setTimeout(refreshDbStatus, 300);
    setDialog(null);
  };

  return (
    <ReactFlowProvider>
      <div className="app">
        <Toolbar onOpen={setDialog} />
        <main className="workspace">
          <div className="canvas">
            <AiBanner onOpenProposals={() => setDialog('proposals')} />
            {!synced && (
              <div className="sync-overlay">
                {status === 'disconnected' ? 'ERD 서버에 연결할 수 없습니다. 서버가 실행 중인지 확인하세요. (다시 연결 중…)' : '프로젝트를 불러오는 중…'}
              </div>
            )}
            <Canvas fitRequest={fitRequest} />
          </div>
          <Inspector />
        </main>
        {dialog === 'sql' && <SqlDialog onClose={close} />}
        {dialog === 'versions' && <VersionsDialog onClose={close} />}
        {dialog === 'dbPull' && <DbPullDialog onClose={close} onDone={() => setFitRequest((n) => n + 1)} />}
        {dialog === 'dbPush' && <DbPushDialog onClose={close} />}
        {dialog === 'definition' && <DefinitionDialog onClose={close} />}
        {dialog === 'ai' && <AiDialog onClose={close} onOpenProposals={() => setDialog('proposals')} />}
        {dialog === 'proposals' && <ProposalsDialog onClose={close} />}
      </div>
    </ReactFlowProvider>
  );
}
