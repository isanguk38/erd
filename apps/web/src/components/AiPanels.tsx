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

type Grant = Awaited<ReturnType<typeof authApi.oauthGrants>>[number];

/** 연결된 AI 목록 (로그인으로 연결한 앱, 예전 방식 토큰). 끊으면 그 AI는 더 이상 ERD를 쓸 수 없다 */
function AiConnections() {
  const [grants, setGrants] = useState<Grant[]>([]);
  const [tokens, setTokens] = useState<TokenInfo[]>([]);
  const load = () => {
    authApi.oauthGrants().then(setGrants).catch(() => setGrants([]));
    authApi.tokens().then(setTokens).catch(() => setTokens([]));
  };
  useEffect(() => {
    load();
  }, []);
  const date = (v?: string) => (v ? new Date(v).toLocaleDateString() : '');
  if (!grants.length && !tokens.length) return <p className="muted small">아직 연결된 AI가 없습니다.</p>;
  return (
    <ul className="token-list">
      {grants.map((g) => (
        <li key={g.id}>
          <b>{g.clientName}</b>
          <span className="tag">로그인</span>
          <span className="muted small">{date(g.createdAt)} 연결{g.lastUsedAt ? ` · ${date(g.lastUsedAt)} 사용` : ''}</span>
          <button
            className="btn btn-sm btn-danger"
            onClick={async () => {
              if (!confirm(`"${g.clientName}" 연결을 끊을까요? 그 앱은 다시 로그인해야 ERD를 쓸 수 있습니다.`)) return;
              await authApi.revokeOauthGrant(g.id);
              load();
            }}
          >
            연결 끊기
          </button>
        </li>
      ))}
      {tokens.map((t) => (
        <li key={t.id}>
          <b>{t.name}</b>
          <span className="tag" title="예전 방식(토큰 직접 붙이기). 로그인으로 다시 연결했다면 끊어도 됩니다">예전 방식 토큰 {t.prefix}…</span>
          <span className="muted small">{date(t.createdAt)} 생성{t.lastUsedAt ? ` · ${date(t.lastUsedAt)} 사용` : ''}</span>
          <button
            className="btn btn-sm btn-danger"
            onClick={async () => {
              if (!confirm(`"${t.name}" 토큰을 취소할까요? 이 토큰을 쓰는 AI는 더 이상 연결할 수 없습니다.`)) return;
              await authApi.revokeToken(t.id);
              load();
            }}
          >
            연결 끊기
          </button>
        </li>
      ))}
    </ul>
  );
}

/** AI 연결 설정: 적용 방식, DB 실행 허용, MCP 연결 방법 */
export function AiDialog({ onClose, onOpenProposals }: { onClose: () => void; onOpenProposals: () => void }) {
  const projectId = useStore((s) => s.projectId)!;
  const meta = useStore((s) => s.meta);
  const role = useStore((s) => s.role);
  const [info, setInfo] = useState<{ authEnabled: boolean; url: string; token: string | null; serverUrl: string; mcpCommand: string[] } | null>(null);
  const [showToken, setShowToken] = useState(false);
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

      {remote ? (
        <>
          {block(
            'oauth',
            'Claude Code에 연결',
            `claude mcp add --transport http erd ${mcpUrl}`,
            '터미널에서 한 번 실행하세요. 처음 쓸 때 브라우저가 열리면 ERD에 로그인하고 "허용"을 누르면 됩니다. MCP 기능이 바뀌면 MCP 설정의 "재인증"을 누르세요. 같은 앱은 연결이 새로 쌓이지 않고 기존 연결을 덮어씁니다.',
          )}
          <section className="ai-section">
            <h4>Claude 앱 · claude.ai에 연결</h4>
            <p className="muted small">설정 → 커넥터 → 사용자 지정 커넥터 추가에서 아래 주소를 넣으면 로그인 화면이 열립니다.</p>
            <div className="kv"><span>주소</span><code>{mcpUrl}</code></div>
          </section>
          <section className="ai-section">
            <h4>연결된 AI</h4>
            <p className="muted small">AI는 나(이 계정)가 볼 수 있는 프로젝트만 다룹니다. 필요 없는 연결은 끊으세요.</p>
            <AiConnections />
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
