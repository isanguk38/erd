import { useEffect, useMemo, useState } from 'react';
import { appliedChanges, generateStatements, getDialect, planPush, syncedBaseline, type RenameLink, type Schema } from '@erd/core';
import { api, projectApi, type Connection, type ExecuteResult, type IntrospectResult } from '../lib/api';
import { safeFileName } from '../lib/download';
import { useStore } from '../store';
import { rememberIfInSync, saveVersion, useDialect, useProjectName } from '../lib/hooks';
import { Modal } from './Modal';
import { ConnectionPicker } from './ConnectionPicker';
import { MigrationPreview } from './MigrationPreview';
import { BaselineInfo, RenamePanel } from './SyncParts';
import { DB_INFO } from '../lib/dbInfo';

type Step = 'compare' | 'confirm' | 'result';

/**
 * 지금 ERD를 DB에 반영한다.
 * DB를 읽어 ERD와 비교하고, 바뀐 부분(CREATE/ALTER/INDEX/FK)만 실행한다. 바뀌지 않은 테이블은 건드리지 않는다.
 */
export function DbPushDialog({ onClose }: { onClose: () => void }) {
  const schema = useStore((s) => s.schema);
  const projectId = useStore((s) => s.projectId)!;
  const [baseline, setBaseline] = useState<{ at: string; schema: Schema } | null>(null);
  const [links, setLinks] = useState<RenameLink[]>([]);
  const projectName = useProjectName();
  const projectDialect = useDialect();
  const [connection, setConnection] = useState<Connection | null>(null);
  const [db, setDb] = useState<IntrospectResult | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [step, setStep] = useState<Step>('compare');
  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<ExecuteResult | null>(null);

  const dialect = getDialect(db?.dialect ?? projectDialect);
  const plan = useMemo(() => (db ? planPush(schema, db.schema, { dialect, baseline: baseline?.schema, links }) : null), [db, schema, dialect, baseline, links]);
  const diff = plan?.diff ?? null;
  // 새로 비교하거나 이름 변경을 확정하면 기본 선택(ERD에서 바뀐 것, DROP 제외)을 다시 정한다
  useEffect(() => {
    if (plan) setSelected(new Set(plan.defaultSelected));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, links, baseline]);
  const statements = useMemo(() => (diff ? generateStatements(diff, dialect, selected) : []), [diff, dialect, selected]);
  const dropCount = statements.filter((s) => s.category === 'drop').length;
  const warningCount = statements.filter((s) => s.warning).length;

  const compare = async () => {
    if (!connection) return;
    setBusy(true);
    setError('');
    setResult(null);
    setStep('compare');
    try {
      const [r, b] = await Promise.all([api.introspect(connection.id), projectApi.baseline(projectId, connection.id)]);
      setLinks([]);
      setBaseline(await rememberIfInSync(projectId, connection.id, r, b));
      setDb(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const execute = async () => {
    if (!connection) return;
    setBusy(true);
    setError('');
    try {
      await saveVersion(`DB 적용 전 · ${connection.name} (${connection.database})`, 'auto');
      const r = await api.execute(connection.id, statements.map((s) => s.sql));
      setResult(r);
      setStep('result');
      if (r.ok) await saveVersion(`DB 적용 · ${connection.name} (${connection.database})`, 'db');
      // 일부만 성공해도 DB는 바뀌었으므로 지금 DB를 다시 읽어 기준 시점으로 저장한다
      if (r.appliedCount > 0) {
        const after = await api.introspect(connection.id);
        // 성공한 문장이 만든 식은 DB가 돌려준 모양과 짝으로 기억한다 (다음 비교에서 DB가 바꿔 쓴 식을 같은 것으로 봄)
        const applied = diff ? appliedChanges(diff.changes, statements, r.results) : [];
        await projectApi.saveBaseline(projectId, connection.id, syncedBaseline(after.schema, useStore.getState().schema, { links, applied, previous: baseline?.schema }));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const needsTyping = dropCount > 0;
  const canExecute = statements.length > 0 && (!needsTyping || confirmText === connection?.database);

  const footer = (
    <>
      <button className="btn" onClick={onClose}>닫기</button>
      {step === 'compare' && diff && diff.changes.length > 0 && (
        <button className="btn btn-primary" disabled={!statements.length} onClick={() => { setConfirmText(''); setStep('confirm'); }}>
          다음: 실행 확인 ({statements.length}문장)
        </button>
      )}
      {step === 'confirm' && (
        <>
          <button className="btn" onClick={() => setStep('compare')}>뒤로</button>
          <button className="btn btn-primary" disabled={!canExecute || busy} onClick={execute}>{busy ? '실행 중…' : 'DB에 실행'}</button>
        </>
      )}
      {/* 실행 뒤 DB를 다시 읽어 기준 시점(식 짝 포함)을 저장하는 동안은 막는다 — 저장 전에 비교하면 처음 맞춘 것처럼 차이가 다시 나온다 */}
      {step === 'result' && <button className="btn btn-primary" disabled={busy} onClick={compare}>{busy ? '기록 중…' : '다시 비교'}</button>}
    </>
  );

  return (
    <Modal title="DB로 내보내기" onClose={onClose} wide footer={footer}>
      <p className="muted small">
        DB의 지금 구조를 읽어 ERD와 비교한 뒤, 바뀐 부분만 실행합니다. 새 테이블은 CREATE, 기존 테이블은 ALTER로 처리하고 인덱스·외래키도 함께 만듭니다.
        바뀌지 않은 테이블은 건드리지 않고, DB에만 있는 테이블의 삭제는 기본으로 실행하지 않습니다.
      </p>
      {step !== 'result' && (
        <ConnectionPicker
          onChange={(c, byUser) => {
            setConnection(c);
            setDb(null);
            setStep('compare');
            if (c || byUser) projectApi.setDbConnection(projectId, c?.id ?? null).catch(() => {});
          }}
        />
      )}
      {connection && step === 'compare' && (
        <div className="toolbar-row">
          <button className="btn btn-primary" disabled={busy} onClick={compare}>{busy ? '읽는 중…' : db ? '다시 비교' : 'DB와 비교'}</button>
          {db && <span className="muted">{db.serverVersion} · DB 테이블 {db.schema.tables.length}개</span>}
          {db && db.dialect !== projectDialect && (
            <span className="warning-inline">프로젝트 DB 종류({getDialect(projectDialect).label})와 다릅니다. {dialect.label} 문법으로 만듭니다.</span>
          )}
        </div>
      )}
      {error && <div className="error-box">{error}</div>}

      {step === 'compare' && plan && plan.diff.changes.length > 0 && <BaselineInfo plan={plan} baselineAt={baseline?.at ?? null} direction="push" />}
      {step === 'compare' && plan && <RenamePanel plan={plan} links={links} onChange={setLinks} />}
      {step === 'compare' && diff && (
        <MigrationPreview
          origins={plan?.origins}
          diff={diff}
          dialect={dialect}
          selected={selected}
          onSelectedChange={setSelected}
          fileName={safeFileName(`${projectName}_${connection?.database ?? 'db'}_migration`)}
          emptyMessage="DB와 ERD가 같습니다. 실행할 것이 없습니다."
        />
      )}

      {step === 'confirm' && connection && (
        <div className="confirm-box">
          <h3>{connection.name} · {connection.host}:{connection.port}/{connection.database}</h3>
          <ul>
            <li>CREATE {statements.filter((s) => s.category === 'create').length}문장, ALTER {statements.filter((s) => s.category === 'alter').length}문장, DROP {dropCount}문장</li>
            {warningCount > 0 && <li className="warning-inline">주의가 필요한 문장 {warningCount}개 (데이터 손실·실패 가능)</li>}
            <li>
              {DB_INFO[dialect.id].transactional
                ? '하나의 트랜잭션으로 실행합니다. 하나라도 실패하면 모두 되돌립니다.'
                : `${dialect.label}은(는) DDL을 되돌릴 수 없어 한 문장씩 실행하고, 실패하면 그 자리에서 멈춥니다.`}
            </li>
            <li>실행 전후로 ERD 버전이 자동 저장됩니다.</li>
          </ul>
          {needsTyping && (
            <label className="confirm-typing">
              삭제 문장이 포함되어 있습니다. 확인을 위해 데이터베이스 이름 <code>{connection.database}</code>을 입력하세요.
              <input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} autoFocus />
            </label>
          )}
          <pre className="sql-view small-view">{statements.map((s) => s.sql + ';').join('\n\n')}</pre>
        </div>
      )}

      {step === 'result' && result && (
        <div className="result-box">
          <div className={result.ok ? 'ok-box' : 'error-box'}>
            {result.ok
              ? `${result.results.length}문장을 모두 실행했습니다.`
              : result.rolledBack
                ? '실패해서 모든 변경을 되돌렸습니다. DB는 실행 전과 같습니다.'
                : `${result.appliedCount}문장까지 반영되고 실패한 곳에서 멈췄습니다. 아래 오류를 확인한 뒤 다시 비교하면 남은 변경만 실행할 수 있습니다.`}
          </div>
          <ol className="exec-results">
            {result.results.map((r, i) => (
              <li key={i} className={r.ok ? 'ok' : r.skipped ? 'skipped' : 'fail'}>
                <span className="exec-status">{r.ok ? '성공' : r.skipped ? '건너뜀' : '실패'}</span>
                <code>{r.sql.split('\n')[0]}{r.sql.includes('\n') ? ' …' : ''}</code>
                {r.error && <div className="exec-error">{r.error}</div>}
              </li>
            ))}
          </ol>
        </div>
      )}
    </Modal>
  );
}
