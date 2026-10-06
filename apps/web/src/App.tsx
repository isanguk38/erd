import { useEffect, useRef, useState } from 'react';
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
import { HelpDialog } from './components/HelpDialog';
import { SearchBox } from './components/SearchBox';
import { MultiSelectPanel } from './components/MultiSelectPanel';
import { TemplateManagerDialog } from './components/TemplatePanels';
import { LintPanel } from './components/LintPanel';
import { Notice } from './components/Notice';
import { CommentsPanel } from './components/Comments';
import { copySelection, pasteClipboard, selectAllTables } from './lib/tableClipboard';
import { ImageExportDialog } from './components/ImageExportDialog';
import { ResizableSide } from './components/ResizableSide';

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
}

/** 로그인하러 간 사이 기억해 둘 초대 토큰 (30분 뒤엔 버린다) */
const PENDING_JOIN = 'erd-pending-join';
const storage = {
  get(key: string): string | null {
    try {
      const v = JSON.parse(localStorage.getItem(key) ?? 'null') as { value: string; at: number } | null;
      return v && Date.now() - v.at < 30 * 60 * 1000 ? v.value : null;
    } catch {
      return null;
    }
  },
  set(key: string, value: string) {
    try {
      localStorage.setItem(key, JSON.stringify({ value, at: Date.now() }));
    } catch {
      /* 저장소를 못 쓰면 링크를 한 번 더 열면 된다 */
    }
  },
  remove(key: string) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* 무시 */
    }
  },
};

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

  // 초대 링크: 로그인한 상태면 참여하고 프로젝트로 이동.
  // 로그인(GitHub)을 다녀오면 주소의 #/join/... 이 사라지므로, 로그인 전에 토큰을 기억해 두었다가 이어서 참여한다.
  const joinToken = hash.match(/^#\/join\/([A-Za-z0-9_-]+)/)?.[1];
  const loggedIn = Boolean(me && (!me.authEnabled || me.user));
  useEffect(() => {
    if (!me) return;
    if (joinToken && !loggedIn) {
      storage.set(PENDING_JOIN, joinToken);
      return;
    }
    if (!loggedIn) return;
    const pending = storage.get(PENDING_JOIN);
    if (!joinToken) {
      if (pending) location.hash = `#/join/${pending}`;
      return;
    }
    storage.remove(PENDING_JOIN);
    authApi
      .join(joinToken)
      .then(({ projectId }) => (location.hash = `#/p/${projectId}`))
      .catch((e) => {
        alert(e instanceof Error ? e.message : String(e));
        location.hash = '#/';
      });
  }, [joinToken, me, loggedIn]);

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
  // 고른 테이블·관계가 지워졌으면(삭제 직후 등) 편집 창을 닫는다
  const hasSelection = useStore((s) => {
    const sel = s.selection;
    if (!sel || !s.inspectorOpen) return false;
    return sel.type === 'table' ? s.schema.tables.some((t) => t.id === sel.id) : s.schema.relations.some((r) => r.id === sel.id);
  });
  const multiSelected = useStore((s) => s.selectedTables.length > 1);
  // 설계 검사·댓글은 캔버스 위 패널(하나씩 열고 닫기), 나머지는 대화상자
  const [sidePanel, setSidePanel] = useState<'lint' | 'comments' | null>(null);
  const openDialog = (name: DialogName | null) =>
    name === 'lint' || name === 'comments' ? setSidePanel((v) => (v === name ? null : name)) : setDialog(name);
  const dialogOpen = useRef(false);
  dialogOpen.current = dialog !== null;
  const isEmpty = useStore((s) => s.schema.tables.length === 0);
  const role = useStore((s) => s.role);

  useEffect(() => {
    useStore.getState().open(projectId);
    return () => useStore.getState().close();
  }, [projectId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Ctrl+F: 브라우저 찾기 대신 테이블·컬럼 검색 (입력 중에도)
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        useStore.getState().setSearchOpen(true);
        return;
      }
      if (e.key === 'F1') {
        e.preventDefault();
        setDialog('help');
        return;
      }
      if (isTyping(e.target) || !(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault();
        useStore.getState().undo();
      } else if (key === 'y' || (key === 'z' && e.shiftKey)) {
        e.preventDefault();
        useStore.getState().redo();
      } else if (key === 'c' || key === 'v' || key === 'a') {
        // 대화상자가 열려 있거나 글자를 고른 상태면 브라우저 기본 동작
        if (dialogOpen.current || window.getSelection()?.toString()) return;
        if (key === 'c') {
          if (copySelection()) e.preventDefault();
        } else if (key === 'v') {
          const { role, compare } = useStore.getState();
          if (role === 'viewer' || compare) return;
          e.preventDefault();
          void pasteClipboard();
        } else {
          e.preventDefault();
          selectAllTables();
        }
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
        <Toolbar onOpen={openDialog} />
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
            <SearchBox />
            {sidePanel === 'lint' && !comparing && <LintPanel onClose={() => setSidePanel(null)} onOpenAi={() => setDialog('ai')} />}
            {sidePanel === 'comments' && !comparing && <CommentsPanel onClose={() => setSidePanel(null)} />}
            {synced && isEmpty && !comparing && (
              <div className="empty-canvas">
                <h3>빈 ERD입니다</h3>
                <p>{role === 'viewer' ? '아직 테이블이 없습니다.' : '빈 곳을 더블클릭하거나 + 테이블로 시작하세요. 기존 DB가 있으면 "DB에서 가져오기"로 불러올 수 있습니다.'}</p>
                <button className="btn" onClick={() => setDialog('help')}>사용 방법 보기</button>
              </div>
            )}
            <Canvas fitRequest={fitRequest} />
          </div>
          {comparing ? (
            <ResizableSide><ComparePanel /></ResizableSide>
          ) : multiSelected ? (
            <MultiSelectPanel />
          ) : hasSelection ? (
            <ResizableSide><Inspector /></ResizableSide>
          ) : null}
        </main>
        {dialog === 'sql' && <SqlDialog onClose={close} />}
        {dialog === 'versions' && <VersionsDialog onClose={close} />}
        {dialog === 'dbPull' && <DbPullDialog onClose={close} onDone={() => setFitRequest((n) => n + 1)} />}
        {dialog === 'dbPush' && <DbPushDialog onClose={close} />}
        {dialog === 'definition' && <DefinitionDialog onClose={close} />}
        {dialog === 'ai' && <AiDialog onClose={close} onOpenProposals={() => setDialog('proposals')} />}
        {dialog === 'proposals' && <ProposalsDialog onClose={close} />}
        {dialog === 'share' && <ShareDialog onClose={close} />}
        {dialog === 'help' && <HelpDialog onClose={close} />}
        {dialog === 'image' && <ImageExportDialog onClose={close} />}
        {dialog === 'templates' && <TemplateManagerDialog onClose={close} />}
        <Notice />
      </div>
    </ReactFlowProvider>
  );
}
