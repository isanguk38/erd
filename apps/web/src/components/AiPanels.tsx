import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { authApi, projectApi, type ChangeSummary, type ProposalInfo, type TokenInfo } from '../lib/api';
import { Modal } from './Modal';

/** AI가 바로 적용한 변경이 있으면 캔버스 위에 띄우는 알림 */
export function AiBanner({ onOpenProposals }: { onOpenProposals: () => void }) {
  const projectId = useStore((s) => s.projectId);
  const session = useStore((s) => s.meta.aiSession);
  const pending = useStore((s) => s.meta.pendingProposals ?? 0);
  const [busy, setBusy] = useState(false);
  if (!projectId || (!session && !pending)) return null;

  return (
    <div className="ai-banner">
      {session && (
        <div className="ai-banner__row">
          <span className="ai-dot" />
          <span>
            <b>AI가 ERD를 {session.changeCount}건 바꿨습니다.</b> <span className="muted">{new Date(session.startedAt).toLocaleTimeString()}부터</span>
          </span>
          <button
            className="btn btn-sm btn-danger"
            disabled={busy}
            onClick={async () => {
              if (!confirm('AI 작업 전 상태로 되돌릴까요? 그 사이 사람이 한 변경도 함께 되돌아갑니다. (되돌리기 전 상태는 버전으로 저장됩니다)')) return;
              setBusy(true);
              try {
                await projectApi.undoAi(projectId);
              } finally {
                setBusy(false);
              }
            }}
          >
            AI 변경 되돌리기
          </button>
          <button className="btn btn-sm" disabled={busy} onClick={() => projectApi.acceptAi(projectId)}>유지</button>
        </div>
      )}
      {pending > 0 && (
        <div className="ai-banner__row">
          <span className="ai-dot proposal" />
          <b>AI 제안 {pending}건이 검토를 기다립니다.</b>
          <button className="btn btn-sm btn-primary" onClick={onOpenProposals}>검토하기</button>
        </div>
      )}
    </div>
  );
}

const CATEGORY = { create: '생성', alter: '수정', drop: '삭제' } as const;

/** AI 제안 검토: 항목별로 골라 반영하거나 거절한다 */
export function ProposalsDialog({ onClose }: { onClose: () => void }) {
  const projectId = useStore((s) => s.projectId)!;
  const pendingCount = useStore((s) => s.meta.pendingProposals ?? 0);
  const [proposals, setProposals] = useState<ProposalInfo[] | null>(null);
  const [selected, setSelected] = useState<Record<string, Set<string>>>({});
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const list = (await projectApi.proposals(projectId)).filter((p) => p.status === 'pending');
    setProposals(list);
    setSelected(Object.fromEntries(list.map((p) => [p.id, new Set(p.changes.filter((c) => c.category !== 'drop').map((c) => c.id))])));
  };
  useEffect(() => {
    load();
    // AI가 제안을 더하면 다시 불러온다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingCount]);

  const toggle = (pid: string, ids: string[], on: boolean) => {
    const next = new Set(selected[pid]);
    ids.forEach((id) => (on ? next.add(id) : next.delete(id)));
    setSelected({ ...selected, [pid]: next });
  };

  return (
    <Modal title="AI 제안 검토" onClose={onClose} wide>
      {!proposals && <div className="muted">불러오는 중…</div>}
      {proposals?.length === 0 && <div className="empty-state">검토할 제안이 없습니다.</div>}
      {proposals?.map((p) => {
        const chosen = selected[p.id] ?? new Set<string>();
        return (
          <section key={p.id} className="proposal">
            <div className="proposal__head">
              <div>
                <b>{p.title}</b>
                <div className="muted small">{new Date(p.updatedAt).toLocaleString()} · 변경 {p.changes.length}건</div>
              </div>
              <div className="btn-row">
                <button
                  className="btn btn-danger btn-sm"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await projectApi.rejectProposal(projectId, p.id);
                      await load();
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  모두 거절
                </button>
                <button
                  className="btn btn-primary btn-sm"
                  disabled={busy || chosen.size === 0}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await projectApi.applyProposal(projectId, p.id, [...chosen]);
                      await load();
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  선택한 {chosen.size}건 반영
                </button>
              </div>
            </div>
            {p.messages.length > 0 && (
              <details className="proposal__messages">
                <summary>AI가 한 작업 {p.messages.length}개</summary>
                <ul>{p.messages.map((m, i) => <li key={i}>{m}</li>)}</ul>
              </details>
            )}
            <ProposalChanges changes={p.changes} chosen={chosen} onToggle={(ids, on) => toggle(p.id, ids, on)} />
          </section>
        );
      })}
    </Modal>
  );
}

function ProposalChanges({ changes, chosen, onToggle }: { changes: ChangeSummary[]; chosen: Set<string>; onToggle: (ids: string[], on: boolean) => void }) {
  if (!changes.length) return <div className="muted small">지금 ERD와 차이가 없습니다.</div>;
  const all = changes.every((c) => chosen.has(c.id));
  return (
    <div className="proposal__changes">
      <label className="check small">
        <input type="checkbox" checked={all} onChange={(e) => onToggle(changes.map((c) => c.id), e.target.checked)} />
        전체 선택
      </label>
      <ul>
        {changes.map((c) => (
          <li key={c.id}>
            <label>
              <input type="checkbox" checked={chosen.has(c.id)} onChange={(e) => onToggle([c.id], e.target.checked)} />
              <span className={`tag tag-${c.category}`}>{CATEGORY[c.category]}</span>
              {c.summary}
            </label>
            {c.warning && <div className="warning">⚠ {c.warning}</div>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 개인 액세스 토큰 (로그인 모드). 만든 직후 한 번만 원문을 보여준다. */
function TokenManager({ onCreated }: { onCreated: (token: string) => void }) {
  const [tokens, setTokens] = useState<TokenInfo[]>([]);
  const [name, setName] = useState('Claude');
  const [fresh, setFresh] = useState('');
  const load = () => authApi.tokens().then(setTokens).catch(() => setTokens([]));
  useEffect(() => {
    load();
  }, []);
  return (
    <div className="token-manager">
      <div className="toolbar-row">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="토큰 이름 (예: 회사 노트북 Claude)" />
        <button
          className="btn btn-primary btn-sm"
          onClick={async () => {
            const t = await authApi.createToken(name);
            setFresh(t.token);
            onCreated(t.token);
            load();
          }}
        >
          새 토큰 만들기
        </button>
      </div>
      {fresh && (
        <div className="ok-box">
          지금만 보여드립니다. 복사해 두세요: <code>{fresh}</code>
          <button className="btn btn-sm" onClick={() => navigator.clipboard.writeText(fresh)}>복사</button>
        </div>
      )}
      <ul className="token-list">
        {tokens.map((t) => (
          <li key={t.id}>
            <b>{t.name}</b>
            <code>{t.prefix}…</code>
            <span className="muted small">
              {new Date(t.createdAt).toLocaleDateString()} 생성{t.lastUsedAt ? ` · ${new Date(t.lastUsedAt).toLocaleDateString()} 사용` : ''}
            </span>
            <button
              className="btn btn-sm btn-danger"
              onClick={async () => {
                if (!confirm(`"${t.name}" 토큰을 취소할까요? 이 토큰을 쓰는 AI는 더 이상 연결할 수 없습니다.`)) return;
                await authApi.revokeToken(t.id);
                load();
              }}
            >
              취소
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** AI 연결 설정: 적용 방식, DB 실행 허용, MCP 연결 방법 */
export function AiDialog({ onClose, onOpenProposals }: { onClose: () => void; onOpenProposals: () => void }) {
  const projectId = useStore((s) => s.projectId)!;
  const meta = useStore((s) => s.meta);
  const role = useStore((s) => s.role);
  const [info, setInfo] = useState<{ authEnabled: boolean; url: string; token: string | null; serverUrl: string; mcpCommand: string[] } | null>(null);
  const [showToken, setShowToken] = useState(false);
  const [newToken, setNewToken] = useState('');
  const [copied, setCopied] = useState('');

  useEffect(() => {
    projectApi.mcpInfo().then(setInfo).catch(() => setInfo(null));
  }, []);

  const copy = async (key: string, text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(''), 1500);
  };

  const remote = Boolean(info?.authEnabled);
  const mcpUrl = info?.url ?? '';

  // 배포(로그인) 모드: 코드를 내려받지 않고 주소 + 개인 토큰만으로 연결한다 (원격 MCP)
  const tokenText = newToken || '<위에서 만든 토큰>';
  const remoteClaudeCode = `claude mcp add --transport http erd ${mcpUrl} --header "Authorization: Bearer ${tokenText}"`;
  const remoteCursor = JSON.stringify({ mcpServers: { erd: { url: mcpUrl, headers: { Authorization: `Bearer ${tokenText}` } } } }, null, 2);
  // Claude Desktop 설정 파일은 원격 주소를 직접 못 받아서, npm의 mcp-remote가 대신 연결해 준다 (Node.js만 있으면 됨)
  const remoteDesktop = JSON.stringify(
    { mcpServers: { erd: { command: 'npx', args: ['-y', 'mcp-remote', mcpUrl, '--header', 'Authorization:${ERD_AUTH}'], env: { ERD_AUTH: `Bearer ${tokenText}` } } } },
    null,
    2,
  );

  // 로컬 모드: 이 PC에서 ERD를 실행 중이므로 저장소의 MCP 프로그램을 직접 실행한다
  const localEnv: Record<string, string> = { ERD_SERVER_URL: info?.serverUrl ?? 'http://127.0.0.1:4000' };
  const [cmd, ...args] = info?.mcpCommand ?? ['node', '<ERD 폴더>/packages/mcp/bin/erd-mcp.mjs'];
  const localDesktop = JSON.stringify({ mcpServers: { erd: { command: cmd, args, env: localEnv } } }, null, 2);
  const localClaudeCode = `claude mcp add erd ${Object.entries(localEnv).map(([k, v]) => `-e ${k}=${v}`).join(' ')} -- ${[cmd, ...args].map((x) => (x.includes(' ') ? `"${x}"` : x)).join(' ')}`;

  const block = (key: string, title: string, code: string, note?: string) => (
    <section className="ai-section" key={key}>
      <h4>{title}</h4>
      {note && <p className="muted small">{note}</p>}
      <pre className="code-block">{code}</pre>
      <button className="btn btn-sm" onClick={() => copy(key, code)}>{copied === key ? '복사됨' : '복사'}</button>
    </section>
  );

  return (
    <Modal title="AI 연결 (MCP)" onClose={onClose} wide>
      <section className="ai-section">
        <h4>AI가 ERD를 바꾸는 방식</h4>
        <div className="choice-list">
          <label className={`choice${meta.aiMode !== 'propose' ? ' active' : ''}`}>
            <input type="radio" disabled={role === 'viewer'} checked={meta.aiMode !== 'propose'} onChange={() => projectApi.update(projectId, { aiMode: 'apply' })} />
            <div>
              <b>바로 적용</b>
              <p className="muted small">AI가 고치면 화면에 바로 반영됩니다. 작업 전 상태가 자동 저장되어 "AI 변경 되돌리기"로 한 번에 되돌릴 수 있습니다.</p>
            </div>
          </label>
          <label className={`choice${meta.aiMode === 'propose' ? ' active' : ''}`}>
            <input type="radio" disabled={role === 'viewer'} checked={meta.aiMode === 'propose'} onChange={() => projectApi.update(projectId, { aiMode: 'propose' })} />
            <div>
              <b>제안 모드</b>
              <p className="muted small">AI의 변경은 제안으로 쌓이고, 사람이 항목별로 골라 반영합니다. 그 사이 사람이 한 변경은 그대로 유지됩니다.</p>
            </div>
          </label>
        </div>
        <label className="check" title={role !== 'owner' ? '프로젝트 소유자만 바꿀 수 있습니다' : ''}>
          <input type="checkbox" disabled={role !== 'owner'} checked={Boolean(meta.aiAllowDbExecute)} onChange={(e) => projectApi.update(projectId, { aiAllowDbExecute: e.target.checked })} />
          AI가 DB에 SQL을 실행하도록 허용 (기본: 끔 — 꺼져 있으면 AI는 SQL 미리보기까지만 할 수 있습니다. 소유자만 변경)
        </label>
        {(meta.pendingProposals ?? 0) > 0 && (
          <button className="btn btn-primary btn-sm" onClick={() => { onClose(); onOpenProposals(); }}>
            대기 중인 제안 {meta.pendingProposals}건 검토
          </button>
        )}
      </section>

      {info?.authEnabled && (
        <section className="ai-section">
          <h4>내 개인 토큰</h4>
          <p className="muted small">AI는 이 토큰의 주인(나)이 볼 수 있는 프로젝트만 다룹니다. 토큰마다 언제든 취소할 수 있습니다.</p>
          <TokenManager onCreated={setNewToken} />
        </section>
      )}

      {remote ? (
        <>
          {!newToken && <div className="baseline-info none">먼저 위에서 <b>새 토큰 만들기</b>를 누르면 아래 설정에 토큰이 자동으로 들어갑니다.</div>}
          {block('cc', 'Claude Code에 연결', remoteClaudeCode, '터미널에서 한 번 실행하면 됩니다. 프로그램을 따로 내려받을 필요가 없습니다.')}
          {block('cursor', 'Cursor · VS Code 등 (mcp.json의 mcpServers에 추가)', remoteCursor)}
          {block('desktop', 'Claude Desktop (claude_desktop_config.json에 추가)', remoteDesktop, 'Claude Desktop은 설정 파일로 원격 주소를 바로 연결하지 못해 mcp-remote가 중간에서 이어 줍니다. PC에 Node.js가 있어야 합니다.')}
          <section className="ai-section">
            <h4>그 밖의 MCP 클라이언트</h4>
            <div className="kv"><span>주소</span><code>{mcpUrl}</code></div>
            <div className="kv"><span>헤더</span><code>Authorization: Bearer {tokenText}</code></div>
          </section>
        </>
      ) : (
        <>
          {block('cc', 'Claude Code에 연결', localClaudeCode)}
          {block('desktop', 'Claude Desktop · Cursor 등 (설정 파일의 mcpServers에 추가)', localDesktop)}
          <section className="ai-section">
            <h4>원격 MCP (Streamable HTTP)</h4>
            <p className="muted small">HTTP로 연결하는 MCP 클라이언트(커넥터)용입니다. 헤더에 <code>Authorization: Bearer &lt;토큰&gt;</code>을 넣습니다.</p>
            <div className="kv"><span>주소</span><code>{mcpUrl || '…'}</code></div>
            {info?.token && (
              <div className="kv">
                <span>토큰</span>
                <code>{showToken ? info.token : `${info.token.slice(0, 8)}••••••••`}</code>
                <button className="btn btn-sm" onClick={() => setShowToken(!showToken)}>{showToken ? '숨기기' : '보기'}</button>
                <button className="btn btn-sm" onClick={() => copy('token', info.token!)}>{copied === 'token' ? '복사됨' : '복사'}</button>
              </div>
            )}
          </section>
        </>
      )}

      <section className="ai-section">
        <h4>이렇게 말해 보세요</h4>
        <ul className="examples">
          <li>"{meta.name} 프로젝트에 쿠폰 기능 테이블 설계해줘. 회원과 연결하고 한글 논리명도 넣어줘"</li>
          <li>"주문 테이블에 조회가 느린데 인덱스 추천해서 추가해줘"</li>
          <li>"개발 DB랑 ERD 비교해서 다른 점 알려줘"</li>
          <li>"바뀐 부분 ALTER SQL 뽑고 테이블 정의서 엑셀로 저장해줘"</li>
        </ul>
      </section>
    </Modal>
  );
}
