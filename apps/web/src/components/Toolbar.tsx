import { useEffect, useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import { addToArea, areaSchema, createColumn, dialectList, getDialect, tableTypeIssues, type ColumnTemplate, type DialectId } from '@erd/core';
import { addTableWithTemplate, useTemplates } from '../lib/templates';
import { useLintCount, useReviewPending } from './LintPanel';
import { useOpenCommentCount } from './Comments';
import { setThemeSetting, useTheme, type ThemeSetting } from '../lib/theme';
import { useStore, type RelationTool, type ViewMode } from '../store';
import { useDbAvailable, useDbStatus, useDialect, useProjectName } from '../lib/hooks';
import { DESKTOP_DOWNLOAD_URL } from '../lib/desktop';

const DESKTOP_ONLY_TITLE = 'DB 가져오기·내보내기는 설치형 앱에서 쓸 수 있습니다. 웹 서버는 사내망이나 내 PC의 DB에 접속할 수 없어서, 앱이 내 PC에서 DB에 직접 연결합니다.';
import { sampleSchema } from '../lib/sample';
import { Dropdown, Icon } from './ui';
import { authApi } from '../lib/api';
import { DesktopUpdateButton } from './DesktopUpdate';
import { FIT_MAX_ZOOM, freeSpot } from '../lib/graph';
import { arrangeTables } from '../lib/arrange';
import { sideWidth } from './ResizableSide';
import { requestFocus } from '../lib/focus';

export type DialogName = 'sql' | 'versions' | 'dbPull' | 'dbPush' | 'definition' | 'ai' | 'proposals' | 'share' | 'help' | 'image' | 'templates' | 'lint' | 'comments' | 'dictionary';

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
  // 버전 비교 중에는 화면이 비교 결과라 편집 버튼을 막는다 (눌러도 보이지 않는 지금 ERD가 바뀌어 헷갈림)
  const comparing = useStore((s) => Boolean(s.compare));
  const readOnly = role === 'viewer' || comparing;
  const readOnlyTitle = comparing ? '버전 비교 중에는 편집할 수 없습니다 (비교 끝내기 후 편집)' : '보기 권한에서는 ERD를 바꿀 수 없습니다';
  const dbAvailable = useDbAvailable();
  const { setDialect, setViewMode, setRelationTool, edit, select, undo, redo, replaceSchema } = useStore.getState();
  const { screenToFlowPosition, fitView, getNodes } = useReactFlow();
  const { status: dbStatus, error: dbError } = useDbStatus();
  const dbChanged = (dbStatus?.db ?? 0) + (dbStatus?.conflict ?? 0);
  const erdPending = dbStatus?.erd ?? 0;
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

  // 지금 탭의 주제영역 (전체면 null)
  const currentArea = () => {
    const { activeArea, schema } = useStore.getState();
    return activeArea ? schema.areas?.find((a) => a.id === activeArea) ?? null : null;
  };
  // 자동 정렬: 화면에서 잰 테이블 크기로 (논리명·긴 인덱스가 있어도 겹치지 않게). 영역 탭이면 그 영역만
  const arrange = async () => {
    await arrangeTables(getNodes());
    setTimeout(() => fitView({ padding: 0.15, duration: 300, maxZoom: FIT_MAX_ZOOM }), 50);
  };

  // 새 테이블은 보이는 캔버스 가운데에. 편집 창이 아직 닫혀 있으면 새 테이블을 고르며 열리므로 그 폭을 빼고 계산한다
  const viewCenter = () => {
    const pane = document.querySelector('.react-flow')?.getBoundingClientRect();
    const side = document.querySelector('.side-resizable') ? 0 : sideWidth();
    const left = pane?.left ?? 0;
    const width = Math.max(240, (pane?.width ?? window.innerWidth) - side);
    const top = pane?.top ?? 0;
    const height = pane?.height ?? window.innerHeight;
    const c = screenToFlowPosition({ x: left + width / 2, y: top + height / 2 });
    // 테이블 왼쪽 위 기준이라 반 폭·반 높이만큼 당기고, 같은 자리에 이미 테이블이 있으면 비켜 놓는다
    // 영역 탭이면 그 영역에 보이는 위치 기준으로 빈 곳을 찾는다
    const { schema } = useStore.getState();
    const area = currentArea();
    const visible = area ? areaSchema(schema, area.id).schema : schema;
    return freeSpot(visible, { x: Math.round(c.x - 120), y: Math.round(c.y - 60) });
  };
  // 메모: 보이는 캔버스 가운데에, 지금 탭(전체 또는 영역)에 붙이고 바로 입력
  const addNoteAtCenter = () => {
    const pane = document.querySelector('.react-flow')?.getBoundingClientRect();
    const c = screenToFlowPosition({ x: (pane?.left ?? 0) + (pane?.width ?? window.innerWidth) / 2, y: (pane?.top ?? 0) + (pane?.height ?? window.innerHeight) / 2 });
    // 테이블을 가리지 않게 가까운 빈 곳으로
    const area = currentArea();
    const { schema } = useStore.getState();
    const position = freeSpot(area ? areaSchema(schema, area.id).schema : schema, { x: Math.round(c.x - 110), y: Math.round(c.y - 60) });
    const id = useStore.getState().addNote({ position, areaId: area?.id ?? null });
    if (id) requestFocus(`note:${id}`);
  };
  // 템플릿을 고르지 않으면 "새 테이블 기본" 템플릿이 들어간다
  const addTableAtCenter = (template?: ColumnTemplate | null) => {
    edit((d) => {
      const position = viewCenter();
      const t = addTableWithTemplate(d, { position }, template);
      // 영역 탭에서 만들면 그 영역에 넣는다
      const area = currentArea();
      if (area) addToArea(d, area.id, [t.id], { [t.id]: position });
      requestFocus(`table:${t.id}`);
      select({ type: 'table', id: t.id }, true);
    });
  };
  // DB 종류 바꾸기: 테이블이 있으면 무엇이 달라지는지 알리고 확인한다 (타입은 SQL을 만들 때 그 DB에 맞게 바뀌고,
  // 그 DB에 없는 타입은 설계 검사에 나온다)
  const changeDialect = (next: DialectId) => {
    const { schema, meta } = useStore.getState();
    const target = getDialect(next);
    const problems = schema.tables.reduce((n, t) => n + tableTypeIssues(target, t).filter((i) => i.severity !== 'info').length, 0);
    if (schema.tables.length) {
      const lines = [
        `DB 종류를 ${target.label}로 바꿀까요?`,
        '',
        `컬럼 타입은 SQL을 만들 때 ${target.label}에 맞게 바뀝니다 (예: DATETIME → ${target.renderType(createColumn({ name: 'x', type: 'DATETIME', length: '' }))}).`,
        problems ? `${target.label}에서 실패하거나 확인이 필요한 컬럼이 ${problems}개 있습니다. 바꾼 뒤 설계 검사에서 확인하세요.` : '',
        meta.dbConnectionId ? '연결해 둔 DB와 종류가 다르면 가져오기·내보내기 비교가 맞지 않습니다.' : '',
      ];
      if (!confirm(lines.filter((l, i) => l || i === 1).join('\n'))) return;
    }
    setDialect(next);
    if (problems) useStore.getState().showNotice({ text: `${target.label}에서 확인이 필요한 컬럼 ${problems}개 — 설계 검사에서 보세요` });
  };
  const lintCount = useLintCount();
  const reviewPending = useReviewPending();
  const { setting: themeSetting, effective: theme } = useTheme();
  const THEME_NEXT: Record<ThemeSetting, ThemeSetting> = { light: 'dark', dark: 'light' };
  const THEME_LABEL: Record<ThemeSetting, string> = { light: '라이트', dark: '다크' };
  const commentCount = useOpenCommentCount();
  const dictionarySize = useStore((s) => (s.dictionary ? `${s.dictionary.terms.length}/${s.dictionary.words.length}` : ''));
  const templates = useTemplates((s) => s.templates);
  const defaultTemplateId = useTemplates((s) => s.defaultTemplateId);
  useEffect(() => void useTemplates.getState().load(), []);


  return (
    <header className="toolbar">
      {/* 위: 프로젝트 · 함께하는 사람 · 검색 · 도움말 · AI · 공유 · 내 계정 */}
      <div className="topbar">
        <a className="icon-btn back" href="#/" title="프로젝트 목록">
          <Icon name="back" size={18} />
        </a>
        <img className="app-logo" src="/favicon.svg" alt="" />
        <ProjectNameInput />
        <select className="chip-select" value={dialect} disabled={!synced || readOnly} onChange={(e) => changeDialect(e.target.value as DialectId)} title="이 프로젝트의 DB 종류">
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
        <button
          className="btn btn-ghost btn-with-badge"
          onClick={() => onOpen('lint')}
          title={`설계 검사: 오류·경고 ${lintCount}개 (기본 검사 + AI 검토)${reviewPending ? ` · AI 검토 이후 바뀐 테이블 ${reviewPending}개 — 다시 검토가 필요합니다` : ''}`}
        >
          <Icon name="check" />
          <span className="hide-narrow">설계 검사</span>
          {lintCount > 0 && <span className="db-badge lint">{lintCount}</span>}
          {/* 숫자는 "문제 수"만. 검토가 밀린 것은 문제가 아니라 할 일이라 작은 점으로만 알린다 */}
          {reviewPending > 0 && <span className="review-dot" aria-label={`AI 검토가 필요한 테이블 ${reviewPending}개`} />}
        </button>
        <button className="btn btn-ghost" onClick={() => onOpen('dictionary')} title={dictionarySize ? `표준 용어 사전: 용어 ${dictionarySize.split('/')[0]}개 · 단어 ${dictionarySize.split('/')[1]}개` : '표준 용어 사전: 엑셀로 올리면 논리명으로 물리명·타입을 채우고 다르면 알려 줍니다'}>
          <Icon name="book" />
          <span className="hide-narrow">용어 사전</span>
        </button>
        <button className="btn btn-ghost btn-with-badge" onClick={() => onOpen('comments')} title="댓글·확인 요청 모아 보기">
          <Icon name="comment" />
          <span className="hide-narrow">댓글</span>
          {commentCount > 0 && <span className="db-badge comment">{commentCount}</span>}
        </button>
        <button
          className="btn btn-ghost icon-only"
          onClick={() => setThemeSetting(THEME_NEXT[themeSetting])}
          title={`화면 테마: ${THEME_LABEL[themeSetting]} (누르면 ${THEME_LABEL[THEME_NEXT[themeSetting]]})`}
          aria-label="화면 테마 바꾸기"
        >
          <Icon name={theme === 'dark' ? 'moon' : 'sun'} />
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
        <DesktopUpdateButton />
        <UserMenu />
      </div>

      {/* 아래: 편집 도구 · DB · 버전 · 내보내기 */}
      <div className="toolstrip">
        <div className="tool-group">
          <div className="split-btn">
            <button className="btn btn-primary" disabled={!synced || readOnly} onClick={() => addTableAtCenter()} title={`테이블 추가 (빈 곳 더블클릭으로도 추가)${defaultTemplateId ? ' · 기본 템플릿이 들어갑니다' : ''}`}>
              <Icon name="plus" />
              <span>테이블</span>
            </button>
            <Dropdown
              label=""
              title="템플릿을 골라 테이블 만들기 · 컬럼 템플릿 관리"
              items={[
                { label: '빈 테이블', hint: '템플릿 없이', disabled: !synced || readOnly, onClick: () => addTableAtCenter(null) },
                ...templates.map((t) => ({
                  label: t.name + (t.id === defaultTemplateId ? ' (기본)' : ''),
                  hint: [...t.top, ...t.bottom].map((c) => c.name).join(', '),
                  disabled: !synced || readOnly,
                  onClick: () => addTableAtCenter(t),
                })),
                { label: '컬럼 템플릿 관리…', hint: '내 공통 컬럼 규격', onClick: () => onOpen('templates') },
              ]}
            />
          </div>
          <button className="btn btn-tool" disabled={!synced || readOnly} onClick={addNoteAtCenter} title="메모 붙이기: 설계 의도·주의 사항을 캔버스에 남깁니다 (SQL·DB에는 영향 없음, 영역 탭이면 그 탭에만)">
            <Icon name="note" />
            <span className="hide-narrow">메모</span>
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
          <button className="btn btn-tool icon-only" title="되돌리기 (Ctrl+Z) · 내가 한 변경만" disabled={!canUndo || readOnly} onClick={undo}>
            <Icon name="undo" />
          </button>
          <button className="btn btn-tool icon-only" title="다시 실행 (Ctrl+Y)" disabled={!canRedo || readOnly} onClick={redo}>
            <Icon name="redo" />
          </button>
          {isEmpty && synced && !readOnly && (
            <button
              className="btn btn-tool"
              onClick={() => {
                replaceSchema(sampleSchema());
                setTimeout(() => fitView({ padding: 0.2, maxZoom: FIT_MAX_ZOOM }), 50);
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
              <button className="btn btn-tool btn-with-badge" disabled={readOnly} onClick={() => onOpen('dbPull')} title={readOnly ? readOnlyTitle : dbTitle}>
                <Icon name="dbIn" />
                <span><span className="hide-narrow">DB에서 </span>가져오기</span>
                {/* DB와 처음 맞추기 전(기준 시점 없음)에는 누가 바꿨는지 몰라 배지를 띄우지 않는다. 차이는 버튼 설명에만 */}
                {dbChanged > 0 && <span className="db-badge" title={dbTitle}>{dbChanged}</span>}
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
            title="SQL·테이블 정의서·ERD 도면(HTML·이미지)으로 추출"
            items={[
              { label: 'SQL 추출', hint: 'CREATE / 변경분 ALTER', onClick: () => onOpen('sql') },
              { label: '테이블 정의서', hint: 'Excel', disabled: isEmpty, onClick: () => onOpen('definition') },
              { label: 'ERD 도면', hint: 'HTML · PNG · SVG', disabled: isEmpty, onClick: () => onOpen('image') },
            ]}
          />
        </div>
      </div>
    </header>
  );
}
