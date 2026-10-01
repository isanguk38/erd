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
import { CompareBanner, ComparePanel } from './components/ComparePanel';
import { LoginPage } from './components/LoginPage';
import { ShareDialog } from './components/ShareDialog';
import { authApi } from './lib/api';

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
}

/** 주소: #/ → 프로젝트 목록, #/p/<id> → 편집기, #/join/<token> → 초대 링크 */
function useHash(): string {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const onHash = () => setHash(location.hash);
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return hash;
}

export function App() {
  const hash = useHash();
  const me = useStore((s) => s.me);
  const [error, setError] = useState('');

  const loadMe = () =>
    authApi
      .me()
      .then((m) => {
        useStore.getState().setMe(m);
        setError('');
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));

  useEffect(() => {
    loadMe();
    // 로그인이 풀리면 다시 확인 → 로그인 화면
    const onUnauthorized = () => loadMe();
    window.addEventListener('erd:unauthorized', onUnauthorized);
    return () => window.removeEventListener('erd:unauthorized', onUnauthorized);
  }, []);

  // 초대 링크: 로그인한 상태면 참여하고 프로젝트로 이동
  const joinToken = hash.match(/^#\/join\/([A-Za-z0-9_-]+)/)?.[1];
  useEffect(() => {
    if (!joinToken || !me || (me.authEnabled && !me.user)) return;
    authApi
      .join(joinToken)
      .then(({ projectId }) => (location.hash = `#/p/${projectId}`))
      .catch((e) => {
        alert(e instanceof Error ? e.message : String(e));
        location.hash = '#/';
      });
  }, [joinToken, me]);

  if (error) return <div className="center-message error-box">{error}</div>;
  if (!me) return <div className="center-message muted">불러오는 중…</div>;
  if (me.authEnabled && !me.user) return <LoginPage me={me} onLoggedIn={loadMe} />;
  if (joinToken) return <div className="center-message muted">프로젝트에 참여하는 중…</div>;
  const projectId = hash.match(/^#\/p\/([a-zA-Z0-9-]+)/)?.[1];
  if (!projectId) return <ProjectsPage />;
  return <Editor key={projectId} projectId={projectId} />;
}

function Editor({ projectId }: { projectId: string }) {
  const [dialog, setDialog] = useState<DialogName | null>(null);
  const [fitRequest, setFitRequest] = useState(0);
  const synced = useStore((s) => s.synced);
  const status = useStore((s) => s.status);
  const comparing = useStore((s) => Boolean(s.compare));
  const openError = useStore((s) => s.openError);

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
            {comparing ? <CompareBanner /> : <AiBanner onOpenProposals={() => setDialog('proposals')} />}
            {(!synced || openError) && (
              <div className="sync-overlay">
                {openError ? (
                  <span>
                    {openError} <a href="#/">프로젝트 목록으로</a>
                  </span>
                ) : status === 'disconnected' ? (
                  'ERD 서버에 연결할 수 없습니다. 서버가 실행 중인지 확인하세요. (다시 연결 중…)'
                ) : (
                  '프로젝트를 불러오는 중…'
                )}
              </div>
            )}
            <Canvas fitRequest={fitRequest} />
          </div>
          {comparing ? <ComparePanel /> : <Inspector />}
        </main>
        {dialog === 'sql' && <SqlDialog onClose={close} />}
        {dialog === 'versions' && <VersionsDialog onClose={close} />}
        {dialog === 'dbPull' && <DbPullDialog onClose={close} onDone={() => setFitRequest((n) => n + 1)} />}
        {dialog === 'dbPush' && <DbPushDialog onClose={close} />}
        {dialog === 'definition' && <DefinitionDialog onClose={close} />}
        {dialog === 'ai' && <AiDialog onClose={close} onOpenProposals={() => setDialog('proposals')} />}
        {dialog === 'proposals' && <ProposalsDialog onClose={close} />}
        {dialog === 'share' && <ShareDialog onClose={close} />}
      </div>
    </ReactFlowProvider>
  );
}
