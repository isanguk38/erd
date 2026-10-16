import { useEffect, useMemo, useState } from 'react';
import { dbmsMismatch, getDialect, planPush, SEED_MAX_ROWS, seedScript, type SeedResult } from '@erd/core';
import { runSeedData } from '../lib/seed';
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
  // 테이블 목록 찾기 (특정 테이블만 넣을 때)
  const [query, setQuery] = useState('');
  const [onlyPicked, setOnlyPicked] = useState(false);
  const [step, setStep] = useState<'make' | 'confirm' | 'result'>('make');
  const [connection, setConnection] = useState<Connection | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [check, setCheck] = useState<{ state: 'running' } | { state: 'done'; differences: string[] } | { state: 'error'; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<ExecuteResult | null>(null);

  // 데이터는 백그라운드(Web Worker)에서 만든다: 테이블이 많아도 창과 화면이 멈추지 않는다.
  // 설정을 바꾸면(행 수 입력 등) 잠깐 기다렸다가, 앞에서 만들던 것은 버리고 다시 만든다
  const [seedResult, setSeedResult] = useState<SeedResult>(EMPTY);
  const [making, setMaking] = useState(true);
  useEffect(() => {
    setMaking(true);
    let run: ReturnType<typeof runSeedData> | null = null;
    let alive = true;
    const timer = setTimeout(() => {
      run = runSeedData(schema, projectDialect, { rows, startId, seed, tableIds: [...picked] });
      run.promise
        .then((r) => {
          if (!alive) return;
          setSeedResult(r);
          setError('');
        })
        .catch((e) => {
          if (!alive) return;
          setSeedResult(EMPTY);
          setError(e instanceof Error ? e.message : String(e));
        })
        .finally(() => alive && setMaking(false));
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
      run?.cancel();
    };
  }, [schema, projectDialect, rows, startId, seed, picked]);
  const script = useMemo(() => seedScript(seedResult), [seedResult]);
  const preview = useMemo(() => {
    const lines = script.split('\n');
    return lines.length > PREVIEW_LINES ? `${lines.slice(0, PREVIEW_LINES).join('\n')}\n-- … (${lines.length - PREVIEW_LINES}줄 더 — 복사·다운로드에는 모두 들어갑니다)` : script;
  }, [script]);
  const total = seedResult.tables.reduce((n, t) => n + t.rows, 0);
  const q = query.trim().toLowerCase();
  const filtering = Boolean(q) || onlyPicked;
  const shown = tables.filter((t) => (!q || t.name.toLowerCase().includes(q) || t.logicalName.toLowerCase().includes(q)) && (!onlyPicked || picked.has(t.id)));
  // 체크하지 않았는데 NOT NULL 외래키 때문에 함께 들어가는 테이블
  const autoAdded = useMemo(() => {
    const names = new Set(seedResult.added);
    return new Set(tables.filter((t) => names.has(t.name) && !picked.has(t.id)).map((t) => t.id));
  }, [seedResult, tables, picked]);

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
              {autoAdded.size > 0 && <span className="muted small"> · 자동 포함 {autoAdded.size}개</span>}
            </summary>
            <div className="seed-tables__tools">
              <input
                className="seed-tables__search"
                type="search"
                placeholder="테이블 찾기 (물리명·논리명)"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="테이블 찾기"
              />
              <label className="seed-tables__only">
                <input type="checkbox" checked={onlyPicked} onChange={(e) => setOnlyPicked(e.target.checked)} /> 체크한 것만
              </label>
              {/* 찾는 중이면 찾은 테이블만 체크·해제 */}
              <button className="btn btn-sm" onClick={() => setPicked(new Set([...picked, ...shown.map((t) => t.id)]))}>{filtering ? `찾은 ${shown.length}개 체크` : '모두'}</button>
              <button className="btn btn-sm" onClick={() => { const off = new Set(shown.map((t) => t.id)); setPicked(new Set([...picked].filter((id) => !off.has(id)))); }}>{filtering ? `찾은 ${shown.length}개 해제` : '없음'}</button>
            </div>
            <div className="seed-tables__list">
              {shown.map((t) => (
                <label key={t.id} className={autoAdded.has(t.id) ? 'auto-added' : undefined}>
                  <input type="checkbox" checked={picked.has(t.id)} onChange={(e) => toggle(t.id, e.target.checked)} />
                  <Highlight text={t.name} query={query} />
                  {t.logicalName ? <span className="muted small"> <Highlight text={t.logicalName} query={query} /></span> : null}
                  {autoAdded.has(t.id) && <span className="seed-auto" title="체크하지 않았지만, 체크한 테이블이 NOT NULL 외래키로 이 테이블을 가리켜 함께 넣습니다">자동 포함</span>}
                </label>
              ))}
              {!shown.length && <span className="muted small">찾는 테이블이 없습니다</span>}
            </div>
          </details>
          <div className="seed-summary">
            {making ? <b className="muted">테스트 데이터를 만드는 중… (테이블 {picked.size}개)</b> : <b>{seedResult.tables.length}개 테이블 · {total}행</b>}
            {!making && seedResult.tables.length > 0 && (
              <span className="muted small" title={seedResult.tables.map((t) => `${t.name}(${t.rows})`).join(' → ')}>
                {' '}넣는 순서: {seedResult.tables.slice(0, 12).map((t) => `${t.name}(${t.rows})`).join(' → ')}{seedResult.tables.length > 12 ? ` → … 외 ${seedResult.tables.length - 12}개` : ''}
              </span>
            )}
          </div>
          {!making && seedResult.added.length > 0 && (
            <p className="muted small" title={seedResult.added.join(', ')}>
              NOT NULL 외래키 때문에 체크하지 않은 부모 테이블 {seedResult.added.length}개도 함께 넣습니다: {seedResult.added.slice(0, 10).join(', ')}{seedResult.added.length > 10 ? ` 외 ${seedResult.added.length - 10}개` : ''}
            </p>
          )}
          {(seedResult.skipped.length > 0 || seedResult.warnings.length > 0) && (
            <>
              {/* 만들지 않은 테이블·참고가 많으면 접어 둔다 (창이 끝없이 길어지지 않게) */}
              {seedResult.skipped.length > 0 && (
                <details className="seed-warnings" open={seedResult.skipped.length <= 5}>
                  <summary className="warning">⚠ 만들지 않은 테이블 {seedResult.skipped.length}개 (NOT NULL 외래키 순환)</summary>
                  <ul>{seedResult.skipped.map((s) => <li key={`s:${s.name}`}>{s.name} — {s.reason}</li>)}</ul>
                </details>
              )}
              {seedResult.warnings.length > 0 && (
                <details className="seed-warnings" open={seedResult.warnings.length <= 5}>
                  <summary className="muted small">ⓘ 참고 {seedResult.warnings.length}건</summary>
                  <ul>{seedResult.warnings.map((w, i) => <li key={i} className="muted small">{w}</li>)}</ul>
                </details>
              )}
            </>
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

/** 찾는 글자를 굵게 */
function Highlight({ text, query }: { text: string; query: string }) {
  const q = query.trim();
  const i = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}
