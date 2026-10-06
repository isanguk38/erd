import { useEffect, useState } from 'react';
import type { DialectId } from '@erd/core';
import { api, type Connection, type ConnectionInput } from '../lib/api';
import { useStore } from '../store';
import { useDialect } from '../lib/hooks';
import { DB_INFO, DB_ORDER, dbLabel } from '../lib/dbInfo';


function emptyInput(dialect: DialectId): ConnectionInput {
  return { name: '', dialect, host: 'localhost', port: DB_INFO[dialect].port, user: '', password: '', database: '', schema: '', ssl: false };
}

/**
 * DB 연결 고르기 + 추가/수정/삭제/연결 확인.
 * 고른 연결은 프로젝트에 기억한다.
 */
/** onChange의 byUser: 사람이 직접 고른 것인지 (연결 해제는 직접 '연결 없음'을 골랐을 때만) */
export function ConnectionPicker({ onChange }: { onChange?: (connection: Connection | null, byUser?: boolean) => void }) {
  // 이 프로젝트에 연결한 DB만 고른 상태로 시작한다 (다른 프로젝트에서 마지막으로 쓴 연결을 가져오지 않는다. 새 프로젝트는 '연결 없음')
  const projectConnectionId = useStore((s) => s.meta.dbConnectionId ?? null);
  const [connectionId, setConnectionId] = useState<string | null>(projectConnectionId);
  const projectDialect = useDialect();
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [editing, setEditing] = useState<{ id?: string; input: ConnectionInput } | null>(null);

  const reload = async (selectId?: string | null) => {
    try {
      const list = await api.listConnections();
      setConnections(list);
      setLoadError('');
      const id = selectId !== undefined ? selectId : connectionId;
      const selected = list.find((c) => c.id === id) ?? null;
      setConnectionId(selected?.id ?? null);
      onChange?.(selected);
      if (!list.length) setEditing({ input: emptyInput(projectDialect) });
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loadError) return <div className="error-box">{loadError}</div>;
  if (!connections) return <div className="muted">연결 목록을 불러오는 중…</div>;

  const selected = connections.find((c) => c.id === connectionId) ?? null;

  if (editing) {
    return (
      <ConnectionForm
        id={editing.id}
        initial={editing.input}
        canCancel={connections.length > 0}
        onCancel={() => setEditing(null)}
        onSaved={async (saved) => {
          setEditing(null);
          await reload(saved.id);
        }}
        onDeleted={async () => {
          setEditing(null);
          await reload(null);
        }}
      />
    );
  }

  return (
    <div className="connection-picker">
      <label className="inline-field">
        DB 연결
        <select
          value={connectionId ?? ''}
          onChange={(e) => {
            const c = connections.find((x) => x.id === e.target.value) ?? null;
            setConnectionId(c?.id ?? null);
            onChange?.(c, true);
          }}
        >
          <option value="">연결 없음 (고르세요)</option>
          {connections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} · {dbLabel(c.dialect)} · {c.host}:{c.port}/{c.database}
            </option>
          ))}
        </select>
      </label>
      {selected && (
        <button className="btn btn-sm" onClick={() => setEditing({ id: selected.id, input: { ...selected, password: '' } })}>
          수정
        </button>
      )}
      <button className="btn btn-sm" onClick={() => setEditing({ input: emptyInput(projectDialect) })}>+ 새 연결</button>
    </div>
  );
}

function ConnectionForm({
  id,
  initial,
  canCancel,
  onCancel,
  onSaved,
  onDeleted,
}: {
  id?: string;
  initial: ConnectionInput;
  canCancel: boolean;
  onCancel: () => void;
  onSaved: (c: Connection) => void;
  onDeleted: () => void;
}) {
  const [input, setInput] = useState<ConnectionInput>(initial);
  const [status, setStatus] = useState<{ kind: 'ok' | 'error' | 'busy'; text: string } | null>(null);
  const set = (patch: Partial<ConnectionInput>) => setInput((prev) => ({ ...prev, ...patch }));
  const info = DB_INFO[input.dialect];

  const test = async () => {
    setStatus({ kind: 'busy', text: '연결 확인 중…' });
    try {
      const { serverVersion } = await api.testConnection({ ...input, id });
      setStatus({ kind: 'ok', text: `연결 성공: ${serverVersion}` });
    } catch (e) {
      setStatus({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
    }
  };

  const save = async () => {
    try {
      const payload = { ...input, name: input.name.trim() || `${input.database}@${input.host}` };
      onSaved(id ? await api.updateConnection(id, payload) : await api.createConnection(payload));
    } catch (e) {
      setStatus({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <div className="connection-form">
      <h4>{id ? 'DB 연결 수정' : '새 DB 연결'}</h4>
      <div className="form-grid wide-label">
        <label>DB 종류</label>
        <div className="segmented">
          {DB_ORDER.map((d) => (
            <button key={d} className={input.dialect === d ? 'active' : ''} onClick={() => set({ dialect: d, port: DB_INFO[d].port })}>
              {dbLabel(d)}
            </button>
          ))}
        </div>
        <label>이름</label>
        <input value={input.name} onChange={(e) => set({ name: e.target.value })} placeholder="예: 개발 DB" />
        <label>호스트</label>
        <div className="row-2">
          <input value={input.host} onChange={(e) => set({ host: e.target.value })} placeholder="localhost" />
          <input className="port" type="number" value={input.port} onChange={(e) => set({ port: Number(e.target.value) })} />
        </div>
        <label>{info.databaseLabel}</label>
        <input value={input.database} onChange={(e) => set({ database: e.target.value })} placeholder={info.databasePlaceholder} />
        {info.schemaPlaceholder && (
          <>
            <label>스키마</label>
            <input value={input.schema ?? ''} onChange={(e) => set({ schema: e.target.value })} placeholder={info.schemaPlaceholder} />
          </>
        )}
        <label>아이디</label>
        <input value={input.user} onChange={(e) => set({ user: e.target.value })} autoComplete="off" />
        <label>비밀번호</label>
        <input
          type="password"
          value={input.password ?? ''}
          onChange={(e) => set({ password: e.target.value })}
          autoComplete="new-password"
          placeholder={id ? '비워 두면 저장된 비밀번호 유지' : ''}
        />
        <label>SSL</label>
        <label className="check">
          <input type="checkbox" checked={Boolean(input.ssl)} onChange={(e) => set({ ssl: e.target.checked })} />
          SSL로 연결 (클라우드 DB)
        </label>
      </div>
      <p className="muted small">
        접속 정보는 이 PC의 ERD 서버에만 암호화되어 저장됩니다. 가져오기는 구조(메타데이터)만 읽고 데이터는 읽지 않습니다.
        가능하면 가져오기용으로는 읽기 전용 계정을 쓰세요.
      </p>
      {status && <div className={status.kind === 'error' ? 'error-box' : status.kind === 'ok' ? 'ok-box' : 'muted'}>{status.text}</div>}
      <div className="btn-row">
        <button className="btn" onClick={test} disabled={status?.kind === 'busy'}>연결 확인</button>
        <button className="btn btn-primary" onClick={save} disabled={!input.host || !input.user || !input.database}>저장</button>
        {canCancel && <button className="btn" onClick={onCancel}>취소</button>}
        {id && (
          <button
            className="btn btn-danger"
            onClick={async () => {
              if (!confirm('이 연결을 삭제할까요?')) return;
              await api.deleteConnection(id);
              onDeleted();
            }}
          >
            삭제
          </button>
        )}
      </div>
    </div>
  );
}
