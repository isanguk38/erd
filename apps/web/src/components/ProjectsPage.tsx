import { useEffect, useMemo, useState, type DragEvent, type ReactNode } from 'react';
import type { DialectId } from '@erd/core';
import { groupApi, projectApi, type GroupInfo, type ProjectInfo } from '../lib/api';
import { clearLegacyProject, legacyProject, useStore } from '../store';
import { UserMenu } from './Toolbar';
import { DB_ORDER, dbLabel } from '../lib/dbInfo';

import { DesktopUpdateButton } from './DesktopUpdate';
import { NoticesPanel } from './NoticesPanel';
import { useAdminRole } from '../lib/notices';
import { Dropdown, Icon } from './ui';
import { buildGroupNodes, groupTrail, LAST_GROUP_KEY, MoveDialog } from './ProjectGroups';

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

const DRAG_PROJECT = 'application/x-erd-project';
const DRAG_GROUP = 'application/x-erd-group';
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** 프로젝트 목록 (#/ 맨 위, #/g/<그룹 id> 그 그룹 안) */
export function ProjectsPage({ groupId = null }: { groupId?: string | null }) {
  const [projects, setProjects] = useState<ProjectInfo[] | null>(null);
  const [groups, setGroups] = useState<GroupInfo[]>([]);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [dialect, setDialect] = useState<DialectId>('mysql');
  const [legacy, setLegacy] = useState(legacyProject);
  const userName = useStore((s) => s.userName);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>(readSort);
  const [newGroup, setNewGroup] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [moving, setMoving] = useState<{ kind: 'project' | 'group'; id: string; name: string; current: string | null } | null>(null);
  const [dropOn, setDropOn] = useState<string | null>(null);
  const adminRole = useAdminRole();
  const changeSort = (next: SortKey) => {
    setSort(next);
    try {
      localStorage.setItem(SORT_KEY, next);
    } catch {
      // 저장이 막혀 있어도 지금 화면에는 적용된다
    }
  };

  const nodes = useMemo(() => buildGroupNodes(groups, projects ?? []), [groups, projects]);
  // 없는 그룹(지워졌거나 남의 그룹) 주소면 맨 위
  const current = groupId && nodes.has(groupId) ? groupId : null;
  const here = current ? nodes.get(current)! : null;
  const trail = groupTrail(nodes, current);
  // 공유받은 그룹 안에서는 만들거나 옮길 수 없다 (공유는 프로젝트 단위)
  const canEditHere = !here?.sharedBy;
  const owns = (p: ProjectInfo) => !p.role || p.role === 'owner';
  useEffect(() => {
    try {
      if (current) sessionStorage.setItem(LAST_GROUP_KEY, current);
      else sessionStorage.removeItem(LAST_GROUP_KEY);
    } catch {
      // 기억하지 못해도 목록은 그대로
    }
  }, [current]);

  const searching = query.trim() !== '';
  // 검색하면 모든 그룹에서 찾고(경로 표시), 아니면 지금 그룹의 것만
  const shown = useMemo(() => {
    const q = norm(query);
    const list = (projects ?? []).filter((p) => (q ? norm(p.name).includes(q) || norm(dbLabel(p.dialect)).includes(q) : (p.groupId ?? null) === current));
    return sort === 'name'
      ? [...list].sort((a, b) => a.name.localeCompare(b.name, 'ko'))
      : [...list].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  }, [projects, query, sort, current]);
  const subgroups = useMemo(
    () => (searching ? [] : [...nodes.values()].filter((n) => n.parentId === current).sort((a, b) => a.name.localeCompare(b.name, 'ko'))),
    [nodes, current, searching],
  );
  const countIn = (id: string) => ({
    groups: [...nodes.values()].filter((n) => n.parentId === id).length,
    projects: (projects ?? []).filter((p) => p.groupId === id).length,
  });

  const load = async () => {
    try {
      const [list, mine] = await Promise.all([projectApi.list(), groupApi.list()]);
      setProjects(list);
      setGroups(mine);
      setError('');
    } catch (e) {
      setError(errText(e));
    }
  };
  useEffect(() => {
    document.title = here ? `${here.name} · ERD` : 'ERD';
  }, [here]);
  useEffect(() => {
    load();
  }, []);
  const run = async (task: () => Promise<unknown>) => {
    try {
      await task();
      await load();
    } catch (e) {
      alert(errText(e));
    }
  };

  const create = async (body: Parameters<typeof projectApi.create>[0]) => {
    const p = await projectApi.create(body);
    location.hash = `#/p/${p.id}`;
  };
  const go = (id: string | null) => {
    setQuery('');
    location.hash = id ? `#/g/${id}` : '#/';
  };

  // 끌어서 놓기: 내 프로젝트·그룹을 내 그룹(또는 경로의 위 그룹)에 놓으면 옮긴다
  const dropProps = (target: string | null) => ({
    onDragOver: (e: DragEvent) => {
      if (!e.dataTransfer.types.includes(DRAG_PROJECT) && !e.dataTransfer.types.includes(DRAG_GROUP)) return;
      e.preventDefault();
      setDropOn(target ?? 'root');
    },
    onDragLeave: () => setDropOn(null),
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      setDropOn(null);
      const pid = e.dataTransfer.getData(DRAG_PROJECT);
      const gid = e.dataTransfer.getData(DRAG_GROUP);
      if (pid) run(() => groupApi.place(pid, target));
      else if (gid && gid !== target) run(() => groupApi.update(gid, { parentId: target }));
    },
  });
  const dropClass = (target: string | null) => (dropOn === (target ?? 'root') ? ' drop-on' : '');
  const inside = (c: { groups: number; projects: number }) => [c.groups && `하위 그룹 ${c.groups}개`, c.projects && `프로젝트 ${c.projects}개`].filter(Boolean).join('·');

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

      {canEditHere && (
        <section className="home-card home-create">
          <div className="home-create__head">
            <h2>
              새 프로젝트
              {here && <span className="home-create__where"><Icon name="folder" size={13} />{here.name}에 만들기</span>}
            </h2>
            <label className="inline-field home-name">
              함께 작업할 때 내 이름
              <input value={userName} onChange={(e) => useStore.getState().setUserName(e.target.value)} placeholder="예: 홍길동" />
            </label>
          </div>
          <form
            className="new-project"
            onSubmit={(e) => {
              e.preventDefault();
              create({ name: name.trim() || '새 프로젝트', dialect, groupId: current }).catch((err) => alert(errText(err)));
            }}
          >
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="프로젝트 이름 (예: 쇼핑몰 주문 관리)" />
            <select value={dialect} onChange={(e) => setDialect(e.target.value as DialectId)} aria-label="DB 종류">
              {DB_ORDER.map((d) => <option key={d} value={d}>{dbLabel(d)}</option>)}
            </select>
            <button className="btn btn-primary" type="submit"><Icon name="plus" size={15} />만들기</button>
          </form>
        </section>
      )}

      {error && <div className="error-box">{error}</div>}
      <section className="home-projects">
        {trail.length > 0 && (
          <nav className="group-trail" aria-label="그룹 경로">
            <button className={`group-trail__item${dropClass(null)}`} onClick={() => go(null)} {...dropProps(null)}>
              <Icon name="layout" size={14} />
              내 프로젝트
            </button>
            {trail.map((n) => (
              <span key={n.id} className="group-trail__step">
                <span className="group-trail__sep" aria-hidden="true">/</span>
                <button className={`group-trail__item${n.id === current ? ' current' : ''}${dropClass(n.id)}`} onClick={() => go(n.id)} {...(n.sharedBy ? {} : dropProps(n.id))}>
                  {n.name}
                </button>
              </span>
            ))}
            {here?.sharedBy && <span className="group-shared">공유받음 · {here.sharedBy}</span>}
          </nav>
        )}
        <div className="home-projects__head">
          <h2>
            {here ? here.name : '내 프로젝트'}
            {projects && subgroups.length + shown.length > 0 && <span className="home-count">{subgroups.length + shown.length}</span>}
          </h2>
          <div className="project-search">
            {canEditHere && !searching && (
              <button className="btn btn-sm home-newgroup" onClick={() => setNewGroup('')} title={here ? `${here.name} 안에 하위 그룹 만들기` : '프로젝트를 묶을 그룹 만들기'}>
                <Icon name="folderPlus" size={15} />
                {here ? '하위 그룹' : '새 그룹'}
              </button>
            )}
            {projects && projects.length > 0 && (
              <>
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
                    placeholder="모든 그룹에서 이름·DB 종류로 검색"
                    aria-label="프로젝트 검색"
                  />
                </span>
                <select value={sort} onChange={(e) => changeSort(e.target.value as SortKey)} aria-label="정렬">
                  <option value="recent">최근 수정순</option>
                  <option value="name">이름순</option>
                </select>
                {searching && <span className="muted small">{shown.length}개</span>}
              </>
            )}
          </div>
        </div>
        {!projects && !error && <div className="home-loading muted small">불러오는 중…</div>}

        {newGroup !== null && (
          <form
            className="group-new"
            onSubmit={(e) => {
              e.preventDefault();
              const n = newGroup.trim();
              if (n) run(async () => {
                await groupApi.create(n, current);
                setNewGroup(null);
              });
            }}
          >
            <Icon name="folder" size={16} />
            <input
              autoFocus
              value={newGroup}
              onChange={(e) => setNewGroup(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && setNewGroup(null)}
              placeholder={here ? `${here.name} 안에 만들 그룹 이름` : '그룹 이름 (예: 회사, 쇼핑몰)'}
              aria-label="그룹 이름"
            />
            <button className="btn btn-primary btn-sm" type="submit">만들기</button>
            <button className="btn btn-sm" type="button" onClick={() => setNewGroup(null)}>취소</button>
          </form>
        )}

        {subgroups.length > 0 && (
          <ul className="group-list">
            {subgroups.map((g) => {
              const c = countIn(g.id);
              const mine = !g.sharedBy;
              return (
                <li
                  key={g.id}
                  className={`group-card${g.sharedBy ? ' shared' : ''}${dropClass(g.id)}`}
                  draggable={mine && renaming?.id !== g.id}
                  onDragStart={(e) => e.dataTransfer.setData(DRAG_GROUP, g.id)}
                  {...(mine ? dropProps(g.id) : {})}
                >
                  {renaming?.id === g.id ? (
                    <form
                      className="group-card__rename"
                      onSubmit={(e) => {
                        e.preventDefault();
                        run(async () => {
                          await groupApi.update(g.id, { name: renaming.name });
                          setRenaming(null);
                        });
                      }}
                    >
                      <input autoFocus value={renaming.name} onChange={(e) => setRenaming({ id: g.id, name: e.target.value })} onKeyDown={(e) => e.key === 'Escape' && setRenaming(null)} aria-label="그룹 이름" />
                      <button className="btn btn-primary btn-sm" type="submit">저장</button>
                    </form>
                  ) : (
                    <a href={`#/g/${g.id}`} onClick={() => setQuery('')}>
                      <span className="group-card__icon" aria-hidden="true"><Icon name="folder" size={20} /></span>
                      <span className="group-card__text">
                        <b>{g.name}</b>
                        <span className="muted small">{g.sharedBy ? `공유받음 · ${g.sharedBy}` : [c.groups && `그룹 ${c.groups}`, `프로젝트 ${c.projects}`].filter(Boolean).join(' · ')}</span>
                      </span>
                    </a>
                  )}
                  {mine && renaming?.id !== g.id && (
                    <Dropdown
                      className="group-card__menu"
                      iconOnly
                      icon="more"
                      label="그룹 메뉴"
                      title="그룹 메뉴"
                      items={[
                        { label: '이름 바꾸기', icon: 'edit', onClick: () => setRenaming({ id: g.id, name: g.name }) },
                        { label: '다른 그룹으로 옮기기', icon: 'move', onClick: () => setMoving({ kind: 'group', id: g.id, name: g.name, current: g.parentId }) },
                        {
                          label: '그룹 삭제',
                          icon: 'trash',
                          onClick: () => {
                            if (c.groups || c.projects) {
                              alert(`"${g.name}" 안에 ${inside(c)}가 있습니다. 먼저 다른 곳으로 옮기거나 지운 뒤 삭제하세요.`);
                              return;
                            }
                            if (confirm(`"${g.name}" 그룹을 삭제할까요?`)) run(() => groupApi.remove(g.id));
                          },
                        },
                      ]}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {projects && projects.length === 0 && groups.length === 0 && (
          <div className="empty-state home-empty">
            <span className="home-empty__icon" aria-hidden="true"><Icon name="table" size={22} /></span>
            <b>아직 프로젝트가 없습니다</b>
            <span>위에서 새로 만들거나, 만든 뒤 "DB에서 가져오기"로 기존 DB를 불러오세요. 프로젝트가 많아지면 "새 그룹"으로 묶어 보세요.</span>
          </div>
        )}
        {projects && !searching && here && subgroups.length === 0 && shown.length === 0 && (
          <div className="empty-state home-empty">
            <span className="home-empty__icon" aria-hidden="true"><Icon name="folder" size={22} /></span>
            <b>{here.name} 그룹이 비어 있습니다</b>
            <span>{canEditHere ? '위에서 이 그룹에 프로젝트나 하위 그룹을 만드세요. 다른 프로젝트를 이 경로로 끌어다 놓아도 됩니다.' : '이 그룹에서 공유받은 프로젝트가 없습니다.'}</span>
          </div>
        )}
        {projects && projects.length > 0 && searching && shown.length === 0 && <div className="empty-state">"{query.trim()}"에 맞는 프로젝트가 없습니다.</div>}
        <ul className="project-list">
          {shown.map((p) => (
            <li key={p.id} className={`db-${p.dialect}`} draggable={owns(p)} onDragStart={(e) => e.dataTransfer.setData(DRAG_PROJECT, p.id)}>
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
                  {searching && (p.groupPath?.length ?? 0) > 0 && (
                    <span className="project-card__path">
                      <Icon name="folder" size={11} />
                      {p.groupPath!.map((g) => g.name).join(' / ')}
                    </span>
                  )}
                </span>
              </a>
              {owns(p) && (
                <span className="project-card__actions">
                  <button className="icon-btn" title="그룹으로 옮기기" aria-label={`${p.name} 옮기기`} onClick={() => setMoving({ kind: 'project', id: p.id, name: p.name, current: p.groupId ?? null })}>
                    <Icon name="move" size={15} />
                  </button>
                  <button
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
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      </section>
      {moving && (
        <MoveDialog
          title={`"${moving.name}" 옮기기`}
          groups={groups}
          current={moving.current}
          skip={moving.kind === 'group' ? moving.id : undefined}
          onMove={async (target) => {
            if (moving.kind === 'project') await groupApi.place(moving.id, target);
            else await groupApi.update(moving.id, { parentId: target });
            await load();
          }}
          onClose={() => setMoving(null)}
        />
      )}
    </div>
    <NoticesPanel />
    </div>
  );
}
