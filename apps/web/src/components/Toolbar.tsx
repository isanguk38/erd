import { useEffect, useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import { addTable, dialectList, type DialectId } from '@erd/core';
import { useStore, type RelationTool, type ViewMode } from '../store';
import { exportDiagram } from '../lib/exportImage';
import { downloadBlob, safeFileName } from '../lib/download';
import { useDbAvailable, useDbStatus, useDialect, useProjectName } from '../lib/hooks';
import { DESKTOP_DOWNLOAD_URL } from '../lib/desktop';

const DESKTOP_ONLY_TITLE = 'DB 가져오기·내보내기는 설치형 앱에서 쓸 수 있습니다. 웹 서버는 사내망이나 내 PC의 DB에 접속할 수 없어서, 앱이 내 PC에서 DB에 직접 연결합니다.';
import { sampleSchema } from '../lib/sample';
import { Dropdown, Icon } from './ui';
import { authApi } from '../lib/api';
import { loadModule } from '../lib/appVersion';

export type DialogName = 'sql' | 'versions' | 'dbPull' | 'dbPush' | 'definition' | 'ai' | 'proposals' | 'share' | 'help';

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

/** 로그인 모드에서 내 계정과 로그아웃 */
export function UserMenu() {
  const me = useStore((s) => s.me);
  if (!me?.authEnabled || !me.user) return null;
  const user = me.user;
  return (
    <Dropdown
      label={
        <span className="user-chip">
          {user.avatarUrl ? <img src={user.avatarUrl} alt="" className="avatar-img" /> : <span className="avatar" style={{ background: 'var(--accent)' }}>{user.name.slice(0, 1)}</span>}
          <span className="hide-narrow">{user.name}</span>
        </span>
      }
      title={`${user.name} (@${user.login})`}
      items={[
        {
          label: '로그아웃',
          onClick: async () => {
            await authApi.logout();
            location.href = '/';
          },
        },
      ]}
    />
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
  const role = useStore((s) => s.role);
  const readOnly = role === 'viewer';
  const dbAvailable = useDbAvailable();
  const { setDialect, setViewMode, setRelationTool, edit, select, undo, redo, replaceSchema } = useStore.getState();
  const { getNodes, getNodesBounds, screenToFlowPosition, fitView } = useReactFlow();
  const [exporting, setExporting] = useState(false);
  const { status: dbStatus, error: dbError } = useDbStatus();
  const dbChanged = (dbStatus?.db ?? 0) + (dbStatus?.conflict ?? 0);
  const erdPending = dbStatus?.erd ?? 0;
  // 기준 시점이 없으면 누가 바꿨는지 몰라 전체 차이만 보여준다
  const unknownDiff = dbStatus?.baselineAt ? 0 : dbStatus?.unknown ?? 0;
  const dbTitle = dbError
    ? `DB 상태 확인 실패: ${dbError}`
    : dbStatus?.connected
      ? `${dbStatus.connection} (${dbStatus.database}) · ${new Date(dbStatus.checkedAt!).toLocaleTimeString()} 확인
` +
        (dbStatus.baselineAt
          ? `DB에서 바뀜 ${dbStatus.db} · ERD에서 바뀜(미적용) ${dbStatus.erd} · 둘 다 바뀜 ${dbStatus.conflict}`
          : `ERD와 다른 곳 ${dbStatus.total}건 (처음 맞추기 전이라 누가 바꿨는지는 모름)`)
      : '연결한 DB의 구조를 읽어 ERD를 만들거나 갱신합니다';

  useEffect(() => {
    document.title = `${projectName} · ERD`;
  }, [projectName]);

  const arrange = async () => {
    const { autoLayout } = await loadModule(() => import('@erd/core/layout'));
    const positions = await autoLayout(useStore.getState().schema);
    edit((d) => {
      for (const t of d.tables) t.position = positions.get(t.id) ?? t.position;
    });
    setTimeout(() => fitView({ padding: 0.15, duration: 300 }), 50);
  };

  const exportImage = async (format: 'png' | 'svg') => {
    setExporting(true);
    try {
      const blob = await exportDiagram(getNodes(), getNodesBounds, format);
      downloadBlob(blob, `${safeFileName(projectName)}.${format}`);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(false);
    }
  };

  const addTableAtCenter = () => {
    const center = screenToFlowPosition({ x: window.innerWidth / 2 - 200, y: window.innerHeight / 2 });
    edit((d) => {
      const t = addTable(d, { position: { x: Math.round(center.x), y: Math.round(center.y) } });
      select({ type: 'table', id: t.id });
    });
  };

  return (
    <header className="toolbar">
      {/* 위: 프로젝트 · 함께하는 사람 · 검색 · 도움말 · AI · 공유 · 내 계정 */}
      <div className="topbar">
        <a className="icon-btn back" href="#/" title="프로젝트 목록">
          <Icon name="back" size={18} />
        </a>
        <img className="app-logo" src="/favicon.svg" alt="" />
        <ProjectNameInput />
        <select className="chip-select" value={dialect} disabled={!synced || readOnly} onChange={(e) => setDialect(e.target.value as DialectId)} title="이 프로젝트의 DB 종류">
          {dialectList.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
        </select>
        {role === 'viewer' && <span className="role-tag" title="이 프로젝트는 보기 권한입니다">보기 전용</span>}
        <span className="spacer" />
        <Participants />
        <span className="divider" />
        <button className="btn btn-ghost" onClick={() => useStore.getState().setSearchOpen(true)} title="테이블·컬럼 찾기 (Ctrl+F)">
          <Icon name="search" />
          <span className="hide-narrow">검색</span>
          <kbd className="hide-narrow">Ctrl F</kbd>
        </button>
        <button className="btn btn-ghost icon-only" onClick={() => onOpen('help')} title="사용 방법 · 단축키">
          <Icon name="help" />
        </button>
        <button className={`btn btn-ghost btn-ai${pendingProposals ? ' has-badge' : ''}`} onClick={() => onOpen(pendingProposals ? 'proposals' : 'ai')} title="AI(MCP) 연결과 제안">
          <Icon name="sparkles" />
          <span>AI</span>
          {pendingProposals ? <span className="badge-count">{pendingProposals}</span> : null}
        </button>
        <button className="btn btn-outline" onClick={() => onOpen('share')} title="함께 작업할 사람 초대">
          <Icon name="share" />
          <span>공유</span>
        </button>
        <UserMenu />
      </div>

      {/* 아래: 편집 도구 · DB · 버전 · 내보내기 */}
      <div className="toolstrip">
        <div className="tool-group">
          <button className="btn btn-primary" disabled={!synced || readOnly} onClick={addTableAtCenter} title="테이블 추가 (빈 곳 더블클릭으로도 추가)">
            <Icon name="plus" />
            <span>테이블</span>
          </button>
          <select className="tool-select" value={relationTool} disabled={readOnly} onChange={(e) => setRelationTool(e.target.value as RelationTool)} title="테이블 오른쪽 점을 끌어 관계를 만들 때의 종류">
            {RELATION_TOOLS.map((t) => <option key={t.id} value={t.id}>관계: {t.label}</option>)}
          </select>
        </div>
        <span className="divider" />
        <div className="segmented" title="이름 표시 방식">
          {VIEW_MODES.map((m) => (
            <button key={m.id} className={viewMode === m.id ? 'active' : ''} onClick={() => setViewMode(m.id)}>{m.label}</button>
          ))}
        </div>
        <span className="divider" />
        <div className="tool-group">
          <button className="btn btn-tool" disabled={isEmpty || readOnly} onClick={arrange} title="관계를 보고 테이블을 자동으로 배치합니다">
            <Icon name="layout" />
            <span className="hide-narrow">자동 정렬</span>
          </button>
          <button className="btn btn-tool icon-only" title="되돌리기 (Ctrl+Z) · 내가 한 변경만" disabled={!canUndo} onClick={undo}>
            <Icon name="undo" />
          </button>
          <button className="btn btn-tool icon-only" title="다시 실행 (Ctrl+Y)" disabled={!canRedo} onClick={redo}>
            <Icon name="redo" />
          </button>
          {isEmpty && synced && !readOnly && (
            <button
              className="btn btn-tool"
              onClick={() => {
                replaceSchema(sampleSchema());
                setTimeout(() => fitView({ padding: 0.2 }), 50);
              }}
            >
              예제 불러오기
            </button>
          )}
        </div>

        <span className="spacer" />

        <div className="tool-group">
          {dbAvailable ? (
            <>
              <button className="btn btn-tool btn-with-badge" disabled={readOnly} onClick={() => onOpen('dbPull')} title={readOnly ? '보기 권한에서는 ERD를 바꿀 수 없습니다' : dbTitle}>
                <Icon name="dbIn" />
                <span><span className="hide-narrow">DB에서 </span>가져오기</span>
                {(dbChanged > 0 || unknownDiff > 0) && <span className="db-badge" title={dbTitle}>{dbChanged || unknownDiff}</span>}
              </button>
              <button className="btn btn-tool btn-with-badge" disabled={isEmpty} onClick={() => onOpen('dbPush')} title={dbStatus?.connected ? `ERD에서 바뀌고 아직 DB에 안 넣은 것 ${erdPending}건` : 'ERD와 DB를 비교해 바뀐 부분만 DB에 실행합니다'}>
                <Icon name="dbOut" />
                <span><span className="hide-narrow">DB로 </span>내보내기</span>
                {erdPending > 0 && <span className="db-badge erd">{erdPending}</span>}
              </button>
            </>
          ) : (
            <>
              {/* 웹에서는 서버가 사용자의 사내망·PC DB에 접속할 수 없어 DB 연결은 설치형 앱에서만 */}
              <button className="btn btn-tool" disabled title={DESKTOP_ONLY_TITLE}>
                <Icon name="dbIn" />
                <span className="hide-narrow">DB에서 가져오기</span>
              </button>
              <button className="btn btn-tool" disabled title={DESKTOP_ONLY_TITLE}>
                <Icon name="dbOut" />
                <span className="hide-narrow">DB로 내보내기</span>
              </button>
              <a className="btn btn-tool desktop-link" href={DESKTOP_DOWNLOAD_URL} target="_blank" rel="noreferrer" title={DESKTOP_ONLY_TITLE}>
                <Icon name="desktop" />
                <span>설치형 앱 받기</span>
              </a>
            </>
          )}
        </div>
        <span className="divider" />
        <div className="tool-group">
          <button className="btn btn-tool" onClick={() => onOpen('versions')} title="버전 저장·비교·복원">
            <Icon name="history" />
            <span className="hide-narrow">버전</span>
          </button>
          <Dropdown
            label="추출"
            icon="download"
            title="SQL·테이블 정의서·이미지로 추출"
            items={[
              { label: 'SQL 추출', hint: 'CREATE / 변경분 ALTER', onClick: () => onOpen('sql') },
              { label: '테이블 정의서', hint: 'Excel', disabled: isEmpty, onClick: () => onOpen('definition') },
              { label: '이미지 PNG', disabled: exporting || isEmpty, onClick: () => exportImage('png') },
              { label: '이미지 SVG', disabled: exporting || isEmpty, onClick: () => exportImage('svg') },
            ]}
          />
        </div>
      </div>
    </header>
  );
}
