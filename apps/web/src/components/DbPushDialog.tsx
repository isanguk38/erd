import { useMemo, useState } from 'react';
import { alignToCurrent, diffSchemas, generateStatements, getDialect, type DiffResult } from '@erd/core';
import { api, type Connection, type ExecuteResult, type IntrospectResult } from '../lib/api';
import { safeFileName } from '../lib/download';
import { useStore } from '../store';
import { Modal } from './Modal';
import { ConnectionPicker } from './ConnectionPicker';
import { MigrationPreview } from './MigrationPreview';

type Step = 'compare' | 'confirm' | 'result';

/**
 * 지금 ERD를 DB에 반영한다.
 * DB를 읽어 ERD와 비교하고, 바뀐 부분(CREATE/ALTER/INDEX/FK)만 실행한다. 바뀌지 않은 테이블은 건드리지 않는다.
 */
export function DbPushDialog({ onClose }: { onClose: () => void }) {
  const schema = useStore((s) => s.schema);
  const projectName = useStore((s) => s.projectName);
  const projectDialect = useStore((s) => s.dialect);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [db, setDb] = useState<IntrospectResult | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [step, setStep] = useState<Step>('compare');
  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<ExecuteResult | null>(null);

  const dialect = getDialect(db?.dialect ?? projectDialect);
  const diff: DiffResult | null = useMemo(() => (db ? diffSchemas(alignToCurrent(db.schema, schema), schema, dialect) : null), [db, schema, dialect]);
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
      const r = await api.introspect(connection.id);
      setDb(r);
      const d = diffSchemas(alignToCurrent(r.schema, schema), schema, getDialect(r.dialect));
      // 삭제는 기본으로 실행하지 않는다 (DB에만 있는 테이블을 지키기 위해)
      setSelected(new Set(d.changes.filter((c) => c.category !== 'drop').map((c) => c.id)));
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
      const { saveVersion } = useStore.getState();
      saveVersion(`DB 적용 전 · ${connection.name} (${connection.database})`, 'auto');
      const r = await api.execute(connection.id, statements.map((s) => s.sql));
      setResult(r);
      setStep('result');
      if (r.ok) saveVersion(`DB 적용 · ${connection.name} (${connection.database})`, 'db');
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
      {step === 'result' && <button className="btn btn-primary" onClick={compare}>다시 비교</button>}
    </>
  );

  return (
    <Modal title="DB로 내보내기" onClose={onClose} wide footer={footer}>
      <p className="muted small">
        DB의 지금 구조를 읽어 ERD와 비교한 뒤, 바뀐 부분만 실행합니다. 새 테이블은 CREATE, 기존 테이블은 ALTER로 처리하고 인덱스·외래키도 함께 만듭니다.
        바뀌지 않은 테이블은 건드리지 않고, DB에만 있는 테이블의 삭제는 기본으로 실행하지 않습니다.
      </p>
      {step !== 'result' && <ConnectionPicker onChange={(c) => { setConnection(c); setDb(null); setStep('compare'); }} />}
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

      {step === 'compare' && diff && (
        <MigrationPreview
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
              {dialect.id === 'postgresql'
                ? '하나의 트랜잭션으로 실행합니다. 하나라도 실패하면 모두 되돌립니다.'
                : 'MySQL은 DDL을 되돌릴 수 없어 한 문장씩 실행하고, 실패하면 그 자리에서 멈춥니다.'}
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
