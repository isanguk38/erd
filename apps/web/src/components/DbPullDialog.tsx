import { useEffect, useMemo, useState } from 'react';
import { alignDb, applyChanges, getDialect, placeNewTables, planPull, type RenameLink, type Schema } from '@erd/core';
import { api, projectApi, type Connection, type IntrospectResult } from '../lib/api';
import { useStore } from '../store';
import { saveVersion } from '../lib/hooks';
import { Modal } from './Modal';
import { ChangeList, type GroupLabel } from './ChangeList';
import { ConnectionPicker } from './ConnectionPicker';
import { BaselineInfo, RenamePanel } from './SyncParts';
import { loadModule } from '../lib/appVersion';

const PULL_GROUPS: Record<'create' | 'alter' | 'drop', GroupLabel> = {
  create: { title: '새 테이블', hint: 'DB에는 있고 ERD에는 없는 테이블' },
  alter: { title: '바뀐 테이블', hint: 'ERD와 DB가 다른 컬럼·인덱스·외래키' },
  drop: { title: 'DB에 없는 테이블', hint: 'ERD에서 지울지 고르세요' },
};

/** DB 구조를 읽어 ERD를 만들거나, 바뀐 부분만 ERD에 반영한다. */
export function DbPullDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const current = useStore((s) => s.schema);
  const projectId = useStore((s) => s.projectId)!;
  const [connection, setConnection] = useState<Connection | null>(null);
  const [commentAs, setCommentAs] = useState<'logicalName' | 'comment'>('logicalName');
  const [result, setResult] = useState<IntrospectResult | null>(null);
  const [baseline, setBaseline] = useState<{ at: string; schema: Schema } | null>(null);
  const [links, setLinks] = useState<RenameLink[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const isEmpty = current.tables.length === 0;

  const plan = useMemo(
    () => (result && !isEmpty ? planPull(current, result.schema, { dialect: getDialect(result.dialect), baseline: baseline?.schema, links }) : null),
    [result, current, isEmpty, baseline, links],
  );
  // 새로 읽거나 이름 변경을 확정하면 기본 선택을 다시 정한다
  useEffect(() => {
    if (plan) setSelected(new Set(plan.defaultSelected));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, links, baseline]);

  const read = async () => {
    if (!connection) return;
    setBusy(true);
    setError('');
    try {
      const [r, b] = await Promise.all([api.introspect(connection.id, commentAs), projectApi.baseline(projectId, connection.id)]);
      setLinks([]);
      setBaseline(b);
      setResult(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!result || !connection) return;
    setBusy(true);
    try {
      const { replaceSchema, setDialect } = useStore.getState();
      const label = `${connection.name} (${connection.database})`;
      if (isEmpty) {
        const schema = structuredClone(result.schema);
        const { autoLayout } = await loadModule(() => import('@erd/core/layout'));
        const positions = await autoLayout(schema);
        for (const t of schema.tables) t.position = positions.get(t.id) ?? t.position;
        replaceSchema(schema);
      } else if (plan) {
        await saveVersion(`DB 가져오기 전 · ${label}`, 'auto');
        const next = applyChanges(current, plan.diff, selected);
        placeNewTables(next, plan.diff.changes.flatMap((c) => (c.kind === 'createTable' && selected.has(c.id) ? [c.table.id] : [])));
        replaceSchema(next);
      }
      setDialect(result.dialect);
      await saveVersion(`DB 가져오기 · ${label}`, 'db');
      // 지금 DB 상태를 기준 시점으로 저장 (다음 비교에서 누가 바꿨는지 구분)
      const erd = useStore.getState().schema;
      await projectApi.saveBaseline(projectId, connection.id, alignDb(result.schema, erd, null, links));
      onDone();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const allSame = plan && plan.diff.changes.length === 0;

  return (
    <Modal
      title="DB에서 가져오기"
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>닫기</button>
          {result && (
            <button className="btn btn-primary" disabled={busy || (!isEmpty && (!selected.size || !!allSame)) || !result.schema.tables.length} onClick={apply}>
              {isEmpty ? `ERD 만들기 (테이블 ${result.schema.tables.length}개)` : `선택한 ${selected.size}건 ERD에 반영`}
            </button>
          )}
        </>
      }
    >
      <p className="muted small">
        연결한 DB의 테이블·컬럼·인덱스·외래키·코멘트를 읽어 {isEmpty ? 'ERD를 새로 그립니다' : '지금 ERD와 비교하고, 고른 변경만 ERD에 반영합니다'}.
        ERD의 배치, 색상, (DB에 코멘트가 없으면) 논리명은 그대로 둡니다.
      </p>
      <ConnectionPicker
        onChange={(c, byUser) => {
          setConnection(c);
          setResult(null);
          if (c || byUser) projectApi.setDbConnection(projectId, c?.id ?? null).catch(() => {});
        }}
      />
      {connection && (
        <div className="toolbar-row">
          <label className="inline-field">
            DB 코멘트를
            <select value={commentAs} onChange={(e) => setCommentAs(e.target.value as 'logicalName' | 'comment')}>
              <option value="logicalName">논리명으로</option>
              <option value="comment">설명으로</option>
            </select>
          </label>
          <button className="btn btn-primary" disabled={busy} onClick={read}>{busy && !result ? '읽는 중…' : result ? '다시 읽기' : 'DB 구조 읽기'}</button>
        </div>
      )}
      {error && <div className="error-box">{error}</div>}
      {result && (
        <>
          <div className="import-summary">
            <b>{result.serverVersion}</b> · 테이블 {result.schema.tables.length}개 · 외래키 {result.schema.relations.length}개
          </div>
          {result.warnings.length > 0 && (
            <details className="import-warnings">
              <summary>참고 {result.warnings.length}건</summary>
              <ul>{result.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
            </details>
          )}
          {isEmpty ? (
            <p className="muted">지금 ERD가 비어 있어 DB 구조로 새로 그립니다. 배치는 관계를 보고 자동으로 정합니다.</p>
          ) : allSame ? (
            <div className="empty-state">ERD와 DB가 같습니다. 반영할 변경이 없습니다.</div>
          ) : (
            plan && (
              <>
                <BaselineInfo plan={plan} baselineAt={baseline?.at ?? null} direction="pull" />
                <RenamePanel plan={plan} links={links} onChange={setLinks} />
                <ChangeList changes={plan.diff.changes} selected={selected} onSelectedChange={setSelected} groups={PULL_GROUPS} origins={plan.origins} />
              </>
            )
          )}
        </>
      )}
    </Modal>
  );
}
