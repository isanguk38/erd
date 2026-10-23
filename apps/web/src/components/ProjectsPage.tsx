import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { DialectId } from '@erd/core';
import { projectApi, type ProjectInfo } from '../lib/api';
import { clearLegacyProject, legacyProject, useStore } from '../store';
import { UserMenu } from './Toolbar';
import { DB_ORDER, dbLabel } from '../lib/dbInfo';

import { DesktopUpdateButton } from './DesktopUpdate';
import { NoticesPanel } from './NoticesPanel';
import { useAdminRole } from '../lib/notices';
import { Icon } from './ui';

type SortKey = 'recent' | 'name';
const SORT_KEY = 'erd.projectSort';
function readSort(): SortKey {
  try {
    return localStorage.getItem(SORT_KEY) === 'name' ? 'name' : 'recent';
  } catch {
    return 'recent';
  }
}

/** 수정 시각을 "3분 전·어제·10월 3일"처럼 */
function ago(iso?: string): string {
  if (!iso) return '';
  const t = new Date(iso);
  const min = Math.floor((Date.now() - t.getTime()) / 60000);
  if (min < 1) return '방금';
  if (min < 60) return `${min}분 전`;
  if (min < 24 * 60) return `${Math.floor(min / 60)}시간 전`;
  const days = Math.floor(min / (24 * 60));
  if (days === 1) return '어제';
  if (days < 7) return `${days}일 전`;
  return t.toLocaleDateString(undefined, { year: t.getFullYear() === new Date().getFullYear() ? undefined : 'numeric', month: 'long', day: 'numeric' });
}

/** 검색어 비교: 대소문자·띄어쓰기 무시 */
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, '');

/** 이름에서 검색어와 맞는 부분을 표시 (띄어쓰기를 무시하고 찾은 경우는 표시 없이) */
function highlight(text: string, query: string): ReactNode {
  const q = query.trim();
  const i = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}

export function ProjectsPage() {
  const [projects, setProjects] = useState<ProjectInfo[] | null>(null);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [dialect, setDialect] = useState<DialectId>('mysql');
  const [legacy, setLegacy] = useState(legacyProject);
  const userName = useStore((s) => s.userName);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>(readSort);
  const adminRole = useAdminRole();
  const changeSort = (next: SortKey) => {
    setSort(next);
    try {
      localStorage.setItem(SORT_KEY, next);
    } catch {
      // 저장이 막혀 있어도 지금 화면에는 적용된다
    }
  };
  // 이름·DB 종류로 거르고 정렬한다
  const shown = useMemo(() => {
    const q = norm(query);
    const list = (projects ?? []).filter((p) => !q || norm(p.name).includes(q) || norm(dbLabel(p.dialect)).includes(q));
    return sort === 'name'
      ? [...list].sort((a, b) => a.name.localeCompare(b.name, 'ko'))
      : [...list].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  }, [projects, query, sort]);

  const load = async () => {
    try {
      setProjects(await projectApi.list());
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  useEffect(() => {
    document.title = 'ERD';
    load();
  }, []);

  const create = async (body: Parameters<typeof projectApi.create>[0]) => {
    const p = await projectApi.create(body);
    location.hash = `#/p/${p.id}`;
  };

  return (
    <div className="projects-layout home">
    <div className="projects-page">
      <header className="projects-page__head">
        <div className="projects-page__title">
          <div className="home-brand">
            <img className="home-logo" src="/favicon.svg" alt="" aria-hidden="true" />
            <div>
              <h1>ERD</h1>
              <p className="muted">함께 그리고, DB와 바로 동기화하고, AI와 같이 설계하는 ERD</p>
            </div>
          </div>
          <div className="home-actions">
            <DesktopUpdateButton />
            {adminRole && (
              <a className="btn btn-ghost btn-sm admin-link" href="#/admin" title="공지사항·업데이트 소식 쓰기">
                <Icon name="shield" size={14} />
                관리자 페이지
              </a>
            )}
            <UserMenu />
          </div>
        </div>
      </header>

      {legacy && (
        <div className="legacy-box">
          <div>이 브라우저에만 저장된 ERD "<b>{legacy.name}</b>" (테이블 {legacy.schema.tables.length}개)가 있습니다.</div>
          <div className="btn-row">
            <button className="btn btn-primary btn-sm" onClick={async () => { await create(legacy); clearLegacyProject(); }}>서버 프로젝트로 옮기기</button>
            <button className="btn btn-sm" onClick={() => { if (confirm('브라우저에 남은 ERD를 지울까요?')) { clearLegacyProject(); setLegacy(null); } }}>지우기</button>
          </div>
        </div>
      )}

      <section className="home-card home-create">
        <div className="home-create__head">
          <h2>새 프로젝트</h2>
          <label className="inline-field home-name">
            함께 작업할 때 내 이름
            <input value={userName} onChange={(e) => useStore.getState().setUserName(e.target.value)} placeholder="예: 홍길동" />
          </label>
        </div>
        <form
          className="new-project"
          onSubmit={(e) => {
            e.preventDefault();
            create({ name: name.trim() || '새 프로젝트', dialect });
          }}
        >
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="프로젝트 이름 (예: 쇼핑몰 주문 관리)" />
          <select value={dialect} onChange={(e) => setDialect(e.target.value as DialectId)} aria-label="DB 종류">
            {DB_ORDER.map((d) => <option key={d} value={d}>{dbLabel(d)}</option>)}
          </select>
          <button className="btn btn-primary" type="submit"><Icon name="plus" size={15} />만들기</button>
        </form>
      </section>

      {error && <div className="error-box">{error}</div>}
      <section className="home-projects">
        <div className="home-projects__head">
          <h2>내 프로젝트{projects && projects.length > 0 && <span className="home-count">{projects.length}</span>}</h2>
          {projects && projects.length > 0 && (
            <div className="project-search">
              <span className="project-search__box">
                <Icon name="search" size={14} />
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    // 결과가 하나면 Enter로 바로 연다
                    if (e.key === 'Enter' && shown.length === 1) location.hash = `#/p/${shown[0].id}`;
                    if (e.key === 'Escape') setQuery('');
                  }}
                  placeholder="이름·DB 종류로 검색"
                  aria-label="프로젝트 검색"
                />
              </span>
              <select value={sort} onChange={(e) => changeSort(e.target.value as SortKey)} aria-label="정렬">
                <option value="recent">최근 수정순</option>
                <option value="name">이름순</option>
              </select>
              {query.trim() && <span className="muted small">{shown.length}개</span>}
            </div>
          )}
        </div>
        {!projects && !error && <div className="home-loading muted small">불러오는 중…</div>}
        {projects && projects.length === 0 && (
          <div className="empty-state home-empty">
            <span className="home-empty__icon" aria-hidden="true"><Icon name="table" size={22} /></span>
            <b>아직 프로젝트가 없습니다</b>
            <span>위에서 새로 만들거나, 만든 뒤 "DB에서 가져오기"로 기존 DB를 불러오세요.</span>
          </div>
        )}
        {projects && projects.length > 0 && query.trim() && shown.length === 0 && (
          <div className="empty-state">"{query.trim()}"에 맞는 프로젝트가 없습니다.</div>
        )}
        <ul className="project-list">
          {shown.map((p) => (
            <li key={p.id} className={`db-${p.dialect}`}>
              <a href={`#/p/${p.id}`}>
                <span className="project-card__mark" aria-hidden="true">{p.name.trim().slice(0, 1).toUpperCase() || 'E'}</span>
                <span className="project-card__text">
                  <b>{highlight(p.name, query)}</b>
                  <span className="muted small">
                    <span className="project-card__db">{dbLabel(p.dialect)}</span>
                    <span className="project-card__meta">
                      <Icon name="table" size={12} /> 테이블 {p.tableCount ?? 0}
                      <span className="dot" />
                      <span title={p.updatedAt ? new Date(p.updatedAt).toLocaleString() : undefined}>{ago(p.updatedAt)}</span>
                      {p.role && p.role !== 'owner' && <span className="project-card__role">{p.role === 'editor' ? '편집 참여' : '보기 참여'}</span>}
                    </span>
                  </span>
                </span>
              </a>
              {(!p.role || p.role === 'owner') && <button
                className="icon-btn danger project-card__delete"
                title="삭제"
                aria-label={`${p.name} 삭제`}
                onClick={async () => {
                  if (!confirm(`"${p.name}" 프로젝트를 삭제할까요? 버전과 제안도 함께 지워지며 되돌릴 수 없습니다.`)) return;
                  await projectApi.remove(p.id);
                  load();
                }}
              >
                <Icon name="trash" size={15} />
              </button>}
            </li>
          ))}
        </ul>
      </section>
    </div>
    <NoticesPanel />
    </div>
  );
}
