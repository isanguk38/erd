import { useEffect, useMemo, useState } from 'react';
import { dbmsMismatch, generateSeedData, getDialect, planPush, SEED_MAX_ROWS, seedScript, type SeedResult } from '@erd/core';
import { api, projectApi, type Connection, type ExecuteResult } from '../lib/api';
import { downloadText, safeFileName } from '../lib/download';
import { useDbAvailable, useDialect, useProjectName } from '../lib/hooks';
import { useStore } from '../store';
import { Modal } from './Modal';
import { ConnectionPicker } from './ConnectionPicker';
import { DbErrorHint } from './SyncParts';

const PREVIEW_LINES = 300;
const EMPTY: SeedResult = { statements: [], tables: [], added: [], skipped: [], warnings: [] };

/**
 * 테스트 데이터: ERD를 보고 외래키·NOT NULL·UNIQUE·ENUM·간단한 CHECK를 지키는 INSERT 문을 만든다 (core/seed.ts).
 * SQL은 복사·다운로드하고, 설치형 앱에서는 고른 개발 DB에 바로 넣을 수 있다 (DB 이름을 입력해 확인).
 */
export function SeedDialog({ onClose }: { onClose: () => void }) {
  const schema = useStore((s) => s.schema);
  const projectId = useStore((s) => s.projectId)!;
  const activeArea = useStore((s) => s.activeArea);
  const projectDialect = useDialect();
  const projectName = useProjectName();
  const dbAvailable = useDbAvailable();
  const dialect = getDialect(projectDialect);
  const area = schema.areas?.find((a) => a.id === activeArea);
  const tables = useMemo(() => schema.tables.filter((t) => !t.name.startsWith('_')), [schema.tables]);
  const [rows, setRows] = useState(20);
  const [startId, setStartId] = useState(1);
  const [seed, setSeed] = useState(1);
  // 영역 탭이면 그 영역 테이블만으로 시작
  const [picked, setPicked] = useState<Set<string>>(() => new Set(area ? area.tableIds : tables.map((t) => t.id)));
  const [copied, setCopied] = useState(false);
  const [step, setStep] = useState<'make' | 'confirm' | 'result'>('make');
  const [connection, setConnection] = useState<Connection | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [check, setCheck] = useState<{ state: 'running' } | { state: 'done'; differences: string[] } | { state: 'error'; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<ExecuteResult | null>(null);

  // 창을 먼저 띄우고 데이터는 그다음에 만든다 (테이블이 많아도 눌렀는데 반응이 없는 것처럼 보이지 않게)
  const [seedResult, setSeedResult] = useState<SeedResult>(EMPTY);
  const [making, setMaking] = useState(true);
  useEffect(() => {
    setMaking(true);
    const timer = setTimeout(() => {
      try {
        setSeedResult(generateSeedData(schema, dialect, { rows, startId, seed, tableIds: [...picked] }));
        setError('');
      } catch (e) {
        setSeedResult(EMPTY);
        setError(`테스트 데이터를 만들지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setMaking(false);
      }
    }, 30);
    return () => clearTimeout(timer);
  }, [schema, dialect, rows, startId, seed, picked]);
  const script = useMemo(() => seedScript(seedResult), [seedResult]);
  const preview = useMemo(() => {
    const lines = script.split('\n');
    return lines.length > PREVIEW_LINES ? `${lines.slice(0, PREVIEW_LINES).join('\n')}\n-- … (${lines.length - PREVIEW_LINES}줄 더 — 복사·다운로드에는 모두 들어갑니다)` : script;
  }, [script]);
  const total = seedResult.tables.reduce((n, t) => n + t.rows, 0);

  const toggle = (id: string, on: boolean) => {
    const next = new Set(picked);
    if (on) next.add(id);
    else next.delete(id);
    setPicked(next);
  };

  // 넣기 전에: ERD 구조가 이 DB에 반영돼 있는지 (안 되어 있으면 INSERT가 실패한다) — 읽기만 한다
  const toConfirm = async () => {
    if (!connection) return;
    const mismatch = dbmsMismatch(projectDialect, connection.dialect);
    if (mismatch) return setError(mismatch);
    setError('');
    setConfirmText('');
    setStep('confirm');
    setCheck({ state: 'running' });
    try {
      const db = await api.introspect(connection.id);
      const names = new Set(seedResult.tables.map((t) => t.name.toLowerCase()));
      const plan = planPush(schema, db.schema, { dialect });
      const differences = plan.diff.changes.filter((c) => c.category !== 'drop' && names.has(c.tableName.toLowerCase())).map((c) => c.summary);
      setCheck({ state: 'done', differences });
    } catch (e) {
      setCheck({ state: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  };

  const execute = async () => {
    if (!connection) return;
    setBusy(true);
    setError('');
    try {
      const r = await api.execute(connection.id, seedResult.statements);
      void projectApi.recordDbLog(projectId, connection, { action: 'seed', stage: 'execute', ok: r.ok, results: r.results, rolledBack: r.rolledBack, appliedCount: r.appliedCount });
      setResult(r);
      setStep('result');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      void projectApi.recordDbLog(projectId, connection, { action: 'seed', stage: 'execute', ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const footer = (
    <>
      <button className="btn" onClick={onClose}>닫기</button>
      {step === 'make' && dbAvailable && (
        <button className="btn btn-primary" disabled={making || !seedResult.statements.length || !connection} onClick={toConfirm} title={connection ? '' : '아래에서 넣을 DB 연결을 고르세요'}>
          다음: DB에 넣기 확인
        </button>
      )}
      {step === 'confirm' && (
        <>
          <button className="btn" onClick={() => setStep('make')}>뒤로</button>
          <button className="btn btn-primary" disabled={busy || confirmText !== connection?.database || check?.state === 'running'} onClick={execute}>
            {busy ? '넣는 중…' : `${total}행 넣기`}
          </button>
        </>
      )}
      {step === 'result' && <button className="btn" onClick={() => { setStep('make'); setResult(null); }}>처음으로</button>}
    </>
  );

  return (
    <Modal title="테스트 데이터 만들기" onClose={onClose} wide footer={footer}>
      {step === 'make' && (
        <>
          <p className="muted small">
            ERD를 보고 외래키·NOT NULL·UNIQUE·ENUM·간단한 CHECK를 지키는 가짜 데이터를 INSERT 문으로 만듭니다. 부모 테이블부터 채우고, 이름·연락처·이메일·금액처럼
            컬럼 이름에 맞는 값을 넣습니다. 개발·테스트 DB에만 쓰세요.
          </p>
          <div className="seed-options">
            <label>테이블마다 <input type="number" min={1} max={SEED_MAX_ROWS} value={rows} onChange={(e) => setRows(Math.max(1, Math.min(SEED_MAX_ROWS, Number(e.target.value) || 1)))} /> 행</label>
            <label title="정수 기본키를 이 번호부터 넣습니다. DB에 이미 데이터가 있으면 겹치지 않게 크게 하세요">시작 번호 <input type="number" min={0} value={startId} onChange={(e) => setStartId(Math.max(0, Number(e.target.value) || 0))} /></label>
            <button className="btn btn-sm" onClick={() => setSeed((n) => n + 1)} title="같은 설정으로 다른 값을 만듭니다">다른 값으로</button>
          </div>
          <details className="seed-tables" open={tables.length <= 12}>
            <summary>
              테이블 {picked.size}/{tables.length}개{area ? ` (지금 영역: ${area.name})` : ''}
              <button className="btn btn-sm" onClick={(e) => { e.preventDefault(); setPicked(new Set(tables.map((t) => t.id))); }}>모두</button>
              <button className="btn btn-sm" onClick={(e) => { e.preventDefault(); setPicked(new Set()); }}>없음</button>
            </summary>
            <div className="seed-tables__list">
              {tables.map((t) => (
                <label key={t.id}>
                  <input type="checkbox" checked={picked.has(t.id)} onChange={(e) => toggle(t.id, e.target.checked)} />
                  {t.name}{t.logicalName ? <span className="muted small"> {t.logicalName}</span> : null}
                </label>
              ))}
            </div>
          </details>
          <div className="seed-summary">
            {making ? <b className="muted">테스트 데이터를 만드는 중… (테이블 {picked.size}개)</b> : <b>{seedResult.tables.length}개 테이블 · {total}행</b>}
            {seedResult.tables.length > 0 && <span className="muted small"> 넣는 순서: {seedResult.tables.map((t) => `${t.name}(${t.rows})`).join(' → ')}</span>}
          </div>
          {seedResult.added.length > 0 && <p className="muted small">NOT NULL 외래키 때문에 부모 테이블도 함께 넣습니다: {seedResult.added.join(', ')}</p>}
          {(seedResult.skipped.length > 0 || seedResult.warnings.length > 0) && (
            <ul className="seed-warnings">
              {seedResult.skipped.map((s) => <li key={`s:${s.name}`} className="warning">⚠ {s.name}: 만들지 않음 — {s.reason}</li>)}
              {seedResult.warnings.map((w, i) => <li key={i} className="muted small">ⓘ {w}</li>)}
            </ul>
          )}
          <pre className="sql-view seed-sql">{making ? '-- 만드는 중…' : preview || '-- 고른 테이블이 없습니다'}</pre>
          <div className="btn-row">
            <button className="btn" disabled={!script} onClick={async () => { await navigator.clipboard.writeText(script); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
              {copied ? '복사됨' : '복사'}
            </button>
            <button className="btn" disabled={!script} onClick={() => downloadText(script + '\n', `${safeFileName(`${projectName}_test_data`)}.sql`, 'application/sql')}>.sql 다운로드</button>
          </div>
          {dbAvailable ? (
            <div className="seed-db">
              <h4>개발 DB에 바로 넣기</h4>
              <ConnectionPicker onChange={(c) => setConnection(c)} />
            </div>
          ) : (
            <p className="muted small">DB에 바로 넣기는 설치형 앱에서 쓸 수 있습니다. 웹에서는 SQL을 복사해 직접 실행하세요.</p>
          )}
          {error && <div className="error-box">{error}</div>}
        </>
      )}

      {step === 'confirm' && connection && (
        <div className="confirm-box">
          <h3>{connection.name} · {connection.host}:{connection.port}/{connection.database}</h3>
          <ul>
            <li>{seedResult.tables.length}개 테이블에 {total}행을 넣습니다 ({seedResult.statements.length}문장). 지우거나 바꾸는 문장은 없습니다.</li>
            <li>
              {dialect.connection.transactional
                ? '하나의 트랜잭션으로 실행합니다. 하나라도 실패하면 모두 되돌립니다.'
                : `${dialect.label}은(는) 한 문장씩 실행하고, 실패하면 그 자리에서 멈춥니다 (앞에서 넣은 행은 남음).`}
            </li>
            <li className="warning-inline">운영 DB에는 넣지 마세요. 기본키·UNIQUE 값이 이미 있는 데이터와 겹치면 실패합니다 — 그럴 땐 시작 번호를 크게 하세요.</li>
          </ul>
          {check?.state === 'running' && <div className="safety-box running">ERD 구조가 이 DB에 반영돼 있는지 확인하는 중… (읽기만 함)</div>}
          {check?.state === 'error' && <div className="safety-box unknown">DB 구조를 읽지 못했습니다: {check.message}</div>}
          {check?.state === 'done' && (check.differences.length ? (
            <div className="safety-box fail">
              <b>ERD와 DB 구조가 달라 실패할 수 있습니다 (먼저 "DB로 내보내기")</b>
              <ul>{check.differences.slice(0, 20).map((d, i) => <li key={i}>{d}</li>)}</ul>
            </div>
          ) : (
            <div className="safety-box ok">고른 테이블의 구조가 ERD와 같습니다.</div>
          ))}
          <label className="confirm-typing">
            넣을 데이터베이스 이름 <code>{connection.database}</code>을 입력해 확인하세요.
            <input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} autoFocus />
          </label>
          {error && <div className="error-box">{error}</div>}
        </div>
      )}

      {step === 'result' && result && (
        <div className="result-box">
          <div className={result.ok ? 'ok-box' : 'error-box'}>
            {result.ok
              ? `${total}행을 넣었습니다 (${result.results.length}문장).`
              : result.rolledBack
                ? '실패해서 모두 되돌렸습니다. DB는 넣기 전과 같습니다.'
                : `${result.appliedCount}문장까지 들어가고 실패한 곳에서 멈췄습니다.`}
          </div>
          <ol className="exec-results">
            {result.results.filter((r) => !r.ok).slice(0, 20).map((r, i) => (
              <li key={i} className={r.skipped ? 'skipped' : 'fail'}>
                <span className="exec-status">{r.skipped ? '건너뜀' : '실패'}</span>
                <code>{r.sql.split('\n')[0]}</code>
                {r.error && <div className="exec-error">{r.error}</div>}
              </li>
            ))}
          </ol>
          {!result.ok && <DbErrorHint />}
        </div>
      )}
    </Modal>
  );
}
