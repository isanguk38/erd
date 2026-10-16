// 관리자 페이지 (#/admin): 공지사항·업데이트 소식 쓰기, 관리자 초대·관리(주인만).
// 관리자 권한은 프로젝트 권한과 따로라 여기서는 소식과 관리자 목록만 다룬다.

import { useEffect, useState } from 'react';
import { adminApi, NOTICE_KIND_LABEL, useAdminRole, type AdminEntry, type AdminInviteInfo, type AdminNotice, type NoticeInput, type NoticeKind } from '../lib/notices';
import { MarkdownEditor } from './MarkdownEditor';
import { UserMenu } from './Toolbar';

const when = (v?: string) => (v ? new Date(v).toLocaleString() : '');
const EMPTY: NoticeInput = { kind: 'notice', title: '', body: '', version: '', pinned: false, published: false };

export function AdminPage() {
  const role = useAdminRole();
  const [tab, setTab] = useState<'notices' | 'admins'>('notices');
  const [checked, setChecked] = useState(false);
  useEffect(() => {
    document.title = '관리자 · ERD';
    const t = setTimeout(() => setChecked(true), 1500);
    return () => clearTimeout(t);
  }, []);

  return (
    <div className="admin-page">
      <header className="admin-page__head">
        <a className="icon-btn back" href="#/" title="프로젝트 목록">←</a>
        <h1>관리자</h1>
        {role && <span className="chip-select">{role === 'owner' ? '주인' : '관리자'}</span>}
        <span className="spacer" />
        <UserMenu />
      </header>
      {!role ? (
        <div className="empty-state">{checked ? '관리자만 들어올 수 있습니다. 관리자에게 초대 링크를 받으세요.' : '확인하는 중…'}</div>
      ) : (
        <>
          <div className="tabs admin-tabs">
            <button className={tab === 'notices' ? 'active' : ''} onClick={() => setTab('notices')}>소식 (공지·업데이트)</button>
            {role === 'owner' && <button className={tab === 'admins' ? 'active' : ''} onClick={() => setTab('admins')}>관리자</button>}
          </div>
          {tab === 'notices' ? <NoticesAdmin /> : <AdminsAdmin />}
        </>
      )}
    </div>
  );
}

function NoticesAdmin() {
  const [list, setList] = useState<AdminNotice[] | null>(null);
  const [editing, setEditing] = useState<{ id: string | null; input: NoticeInput } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () => adminApi.notices().then(setList).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  useEffect(() => void load(), []);
  const current = editing?.id ? list?.find((n) => n.id === editing.id) : null;

  const pick = (n: AdminNotice) => {
    setError('');
    setEditing({ id: n.id, input: { kind: n.kind, title: n.title, body: n.body, version: n.version ?? '', pinned: n.pinned, published: n.published } });
  };
  const set = (patch: NoticeInput) => editing && setEditing({ ...editing, input: { ...editing.input, ...patch } });
  const save = async () => {
    if (!editing) return;
    setBusy(true);
    setError('');
    try {
      const input = { ...editing.input, version: editing.input.kind === 'app' ? editing.input.version : null };
      const saved = editing.id ? await adminApi.update(editing.id, input) : await adminApi.create(input);
      await load();
      setEditing({ id: saved.id, input: { kind: saved.kind, title: saved.title, body: saved.body, version: saved.version ?? '', pinned: saved.pinned, published: saved.published } });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="admin-notices">
      <section className="admin-notices__list">
        <button className="btn btn-primary" onClick={() => { setError(''); setEditing({ id: null, input: { ...EMPTY } }); }}>+ 새 글</button>
        {!list ? (
          <p className="muted small">불러오는 중…</p>
        ) : list.length === 0 ? (
          <p className="muted small">아직 글이 없습니다.</p>
        ) : (
          <ul>
            {list.map((n) => (
              <li key={n.id}>
                <button className={`admin-notice-row${editing?.id === n.id ? ' active' : ''}`} onClick={() => pick(n)}>
                  <span className={`notice-kind kind-${n.kind}`}>{n.kind === 'app' && n.version ? `앱 ${n.version}` : NOTICE_KIND_LABEL[n.kind]}</span>
                  <span className="admin-notice-row__title">{n.pinned && '📌 '}{n.title}</span>
                  <span className={`admin-status ${n.published ? 'on' : 'off'}`}>{n.published ? '게시' : '임시'}</span>
                  <span className="muted small">{when(n.publishedAt ?? n.updatedAt)} · {n.updatedBy}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="admin-notices__edit">
        {!editing ? (
          <div className="empty-state">왼쪽에서 글을 고르거나 "+ 새 글"을 누르세요.</div>
        ) : (
          <>
            <div className="form-grid admin-form">
              <label>종류</label>
              <select value={editing.input.kind} onChange={(e) => set({ kind: e.target.value as NoticeKind })}>
                <option value="notice">공지·주의사항</option>
                <option value="web">웹 업데이트</option>
                <option value="app">앱 업데이트 (설치형 앱 버전)</option>
              </select>
              {editing.input.kind === 'app' && (
                <>
                  <label>앱 버전</label>
                  <input value={editing.input.version ?? ''} onChange={(e) => set({ version: e.target.value })} placeholder="예: 0.2.9 — 그 버전 업데이트 창에 이 내용이 나옵니다" />
                </>
              )}
              <label>제목</label>
              <input value={editing.input.title ?? ''} onChange={(e) => set({ title: e.target.value })} placeholder="예: 테스트 데이터 만들기가 빨라졌습니다" />
              <label>내용</label>
              <div>
                <MarkdownEditor value={editing.input.body ?? ''} onChange={(body) => set({ body })} />
                <p className="muted small">위 버튼으로 꾸미거나 마크다운을 바로 써도 됩니다 (표·링크·이미지 주소·체크리스트·인용·이모지). 오른쪽이 사용자에게 보이는 모양입니다.</p>
              </div>
              <label>표시</label>
              <div className="admin-flags">
                <label><input type="checkbox" checked={Boolean(editing.input.published)} onChange={(e) => set({ published: e.target.checked })} /> 게시 (끄면 임시 저장 — 사용자에게 안 보임)</label>
                <label><input type="checkbox" checked={Boolean(editing.input.pinned)} onChange={(e) => set({ pinned: e.target.checked })} /> 위에 고정 (중요한 주의사항)</label>
              </div>
            </div>
            {error && <div className="error-box">{error}</div>}
            <div className="btn-row">
              <button className="btn btn-primary" disabled={busy} onClick={save}>{busy ? '저장 중…' : editing.id ? '저장' : '만들기'}</button>
              {editing.id && (
                <button
                  className="btn btn-danger"
                  onClick={async () => {
                    if (!confirm('이 글을 지울까요? 되돌릴 수 없습니다 (내리기만 하려면 "게시"를 끄고 저장하세요).')) return;
                    await adminApi.remove(editing.id!);
                    setEditing(null);
                    load();
                  }}
                >
                  삭제
                </button>
              )}
            </div>
            {current && (
              <div className="admin-meta muted small">
                {current.createdBy}이(가) {when(current.createdAt)}에 씀 · 마지막 수정 {current.updatedBy} {when(current.updatedAt)}
                {current.publishedAt && ` · 게시 ${when(current.publishedAt)}`}
              </div>
            )}
            {current && current.revisions.length > 0 && (
              <details className="admin-revisions">
                <summary>수정 이력 {current.revisions.length}개</summary>
                <ul>
                  {current.revisions.map((r) => (
                    <li key={r.at}>
                      <span>{when(r.at)} · {r.by} · <b>{r.title}</b></span>
                      <button
                        className="btn btn-sm"
                        onClick={async () => {
                          if (!confirm('이 내용으로 되돌릴까요? (지금 내용은 이력에 남습니다)')) return;
                          const back = await adminApi.restore(current.id, r.at);
                          await load();
                          pick(back);
                        }}
                      >
                        이 내용으로 되돌리기
                      </button>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </>
        )}
      </section>
    </div>
  );
}

function AdminsAdmin() {
  const [data, setData] = useState<{ owners: string[]; admins: AdminEntry[]; invites: AdminInviteInfo[] } | null>(null);
  const [login, setLogin] = useState('');
  const [made, setMade] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const load = () => adminApi.admins().then(setData).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  useEffect(() => void load(), []);
  const status = { open: '기다리는 중', used: '수락함', expired: '만료' } as const;

  return (
    <div className="admin-admins">
      <section>
        <h3>주인</h3>
        <p className="muted small">서버 설정(ERD_ADMIN_GITHUB)에 적은 GitHub 계정입니다. 화면에서는 뺄 수 없습니다.</p>
        <ul>{(data?.owners.length ? data.owners : ['(로컬 모드: 내 PC 사용자)']).map((o) => <li key={o}><b>{o}</b></li>)}</ul>
      </section>
      <section>
        <h3>관리자</h3>
        {data && data.admins.length === 0 && <p className="muted small">초대한 관리자가 없습니다.</p>}
        <ul>
          {data?.admins.map((a) => (
            <li key={a.userId}>
              <b>{a.name}</b> <span className="muted">@{a.login} · {when(a.addedAt)} 추가 ({a.addedBy} 초대)</span>
              <button
                className="btn btn-sm btn-danger"
                onClick={async () => {
                  if (!confirm(`${a.login}을(를) 관리자에서 뺄까요? 이 사람의 프로젝트는 그대로입니다.`)) return;
                  await adminApi.removeAdmin(a.userId);
                  load();
                }}
              >
                빼기
              </button>
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h3>관리자 초대</h3>
        <p className="muted small">링크는 한 번만 쓸 수 있고 24시간 뒤 만료됩니다. GitHub 아이디를 적으면 그 계정만 수락할 수 있습니다 (권장).</p>
        <div className="toolbar-row">
          <input value={login} onChange={(e) => setLogin(e.target.value)} placeholder="GitHub 아이디 (예: octocat)" />
          <button
            className="btn btn-primary"
            onClick={async () => {
              setError('');
              try {
                const r = await adminApi.invite(login.trim() || undefined);
                setMade(r.url);
                setCopied(false);
                setLogin('');
                load();
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              }
            }}
          >
            초대 링크 만들기
          </button>
        </div>
        {made && (
          <div className="admin-invite-link">
            <code>{made}</code>
            <button className="btn btn-sm" onClick={async () => { await navigator.clipboard.writeText(made); setCopied(true); }}>{copied ? '복사됨' : '복사'}</button>
            <p className="muted small">이 링크는 지금만 보입니다. 초대할 사람에게 전달하세요.</p>
          </div>
        )}
        {error && <div className="error-box">{error}</div>}
        {data && data.invites.length > 0 && (
          <ul className="admin-invites">
            {data.invites.map((i) => (
              <li key={i.id}>
                <span className={`admin-status ${i.status === 'open' ? 'on' : 'off'}`}>{status[i.status]}</span>
                <span>{i.login ? `@${i.login}만` : '누구나'} · {i.createdBy} · {when(i.createdAt)}{i.usedBy ? ` · ${i.usedBy} 수락` : ` · ${when(i.expiresAt)}까지`}</span>
                {i.status === 'open' && <button className="btn btn-sm" onClick={async () => { await adminApi.cancelInvite(i.id); load(); }}>취소</button>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** 초대 링크 (#/admin/join/<token>): 로그인한 계정으로 수락 */
export function AdminJoin({ token, onDone }: { token: string; onDone: () => void }) {
  const [state, setState] = useState<{ error?: string; ok?: boolean }>({});
  useEffect(() => {
    adminApi
      .accept(token)
      .then(() => setState({ ok: true }))
      .catch((e) => setState({ error: e instanceof Error ? e.message : String(e) }));
  }, [token]);
  return (
    <div className="center-message">
      {!state.ok && !state.error && <p className="muted">관리자 초대를 확인하는 중…</p>}
      {state.ok && (
        <>
          <p>관리자가 되었습니다. 공지사항과 업데이트 소식을 쓸 수 있습니다.</p>
          <button className="btn btn-primary" onClick={onDone}>관리자 페이지로</button>
        </>
      )}
      {state.error && (
        <>
          <div className="error-box">{state.error}</div>
          <a className="btn" href="#/">프로젝트 목록으로</a>
        </>
      )}
    </div>
  );
}
