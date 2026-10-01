import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { authApi, type Member, type ShareLink } from '../lib/api';
import { Modal } from './Modal';

const ROLE_LABEL = { owner: '소유자', editor: '편집', viewer: '보기' } as const;

export function ShareDialog({ onClose }: { onClose: () => void }) {
  const projectId = useStore((s) => s.projectId)!;
  const me = useStore((s) => s.me);
  const [members, setMembers] = useState<Member[]>([]);
  const [shares, setShares] = useState<ShareLink[]>([]);
  const [myRole, setMyRole] = useState<string>('viewer');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  const isOwner = myRole === 'owner';

  const load = async () => {
    try {
      const a = await authApi.access(projectId);
      setMembers(a.members);
      setShares(a.shares);
      setMyRole(a.myRole);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const copy = async (url: string) => {
    await navigator.clipboard.writeText(url);
    setCopied(url);
    setTimeout(() => setCopied(''), 1500);
  };

  if (!me?.authEnabled) {
    return (
      <Modal title="공유" onClose={onClose}>
        <div className="empty-state">
          지금은 <b>로컬 모드</b>입니다 (내 PC에서만 열림). 다른 사람과 함께 쓰려면 서버를 배포하고 GitHub 로그인을 설정하세요. README의 "배포"를 참고하세요.
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="공유" onClose={onClose}>
      {error && <div className="error-box">{error}</div>}
      <section className="ai-section">
        <h4>함께하는 사람 {members.length}명</h4>
        <ul className="member-list">
          {members.map((m) => (
            <li key={m.user?.id ?? Math.random()}>
              {m.user?.avatarUrl ? <img src={m.user.avatarUrl} alt="" className="avatar-img" /> : <span className="avatar" style={{ background: 'var(--accent)' }}>{m.user?.name.slice(0, 1)}</span>}
              <span className="grow">
                <b>{m.user?.name ?? '알 수 없음'}</b> <span className="muted small">@{m.user?.login}</span>
                {m.user?.id === me.user?.id && <span className="muted small"> (나)</span>}
              </span>
              {isOwner && m.role !== 'owner' && m.user ? (
                <>
                  <select value={m.role} onChange={async (e) => { await authApi.setMemberRole(projectId, m.user!.id, e.target.value as 'editor' | 'viewer'); load(); }}>
                    <option value="editor">편집</option>
                    <option value="viewer">보기</option>
                  </select>
                  <button className="icon-btn danger" title="내보내기" onClick={async () => { if (confirm(`${m.user!.name}님을 프로젝트에서 내보낼까요?`)) { await authApi.removeMember(projectId, m.user!.id); load(); } }}>×</button>
                </>
              ) : (
                <span className="role-tag">{ROLE_LABEL[m.role]}</span>
              )}
            </li>
          ))}
        </ul>
      </section>

      {isOwner && (
        <section className="ai-section">
          <h4>초대 링크</h4>
          <p className="muted small">링크를 받은 사람은 로그인한 뒤 프로젝트에 참여합니다. 필요 없어지면 링크를 취소하세요.</p>
          <div className="btn-row">
            <button className="btn btn-primary btn-sm" onClick={async () => { await authApi.createShare(projectId, 'editor'); load(); }}>편집 링크 만들기</button>
            <button className="btn btn-sm" onClick={async () => { await authApi.createShare(projectId, 'viewer'); load(); }}>보기 링크 만들기</button>
          </div>
          <ul className="share-list">
            {shares.map((s) => (
              <li key={s.token}>
                <span className="role-tag">{ROLE_LABEL[s.role]}</span>
                <code className="grow">{s.url}</code>
                <button className="btn btn-sm" onClick={() => copy(s.url)}>{copied === s.url ? '복사됨' : '복사'}</button>
                <button className="btn btn-sm btn-danger" onClick={async () => { await authApi.removeShare(projectId, s.token); load(); }}>취소</button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </Modal>
  );
}
