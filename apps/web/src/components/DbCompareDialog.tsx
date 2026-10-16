import { useEffect, useMemo, useState } from 'react';
import { getDialect, planPush, type RenameLink } from '@erd/core';
import { api, type Connection, type IntrospectResult } from '../lib/api';
import { safeFileName } from '../lib/download';
import { useDialect, useProjectName } from '../lib/hooks';
import { useStore } from '../store';
import { Modal } from './Modal';
import { MigrationPreview } from './MigrationPreview';
import { RenamePanel } from './SyncParts';
import type { GroupLabel } from './ChangeList';

const COMPARE_GROUPS: Record<'create' | 'alter' | 'drop', GroupLabel> = {
  create: { title: '기준에만 있음', hint: '대상 DB에 없는 테이블·객체' },
  alter: { title: '다름', hint: '두 DB에서 컬럼·인덱스·외래키가 다른 테이블' },
  drop: { title: '대상에만 있음', hint: '기준 DB에는 없는 테이블 (삭제는 직접 골라야 SQL에 들어감)' },
};

/**
 * DB끼리 비교: 두 연결(예: 개발·운영)의 구조를 읽어 차이를 보여 주고, 대상 DB를 기준과 같게 만드는 SQL을 만든다.
 * 두 DB 모두 읽기만 한다. SQL은 복사·다운로드만 하고 실행하지 않는다 (운영 DB 반영은 사람이 검토한 뒤).
 */
export function DbCompareDialog({ onClose }: { onClose: () => void }) {
  const projectDialect = useDialect();
  const projectName = useProjectName();
  const projectConnectionId = useStore((s) => s.meta.dbConnectionId ?? null);
  const dialect = getDialect(projectDialect);
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [sourceId, setSourceId] = useState('');
  const [targetId, setTargetId] = useState('');
  const [read, setRead] = useState<{ source: IntrospectResult; target: IntrospectResult; sourceName: string; targetName: string } | null>(null);
  const [links, setLinks] = useState<RenameLink[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .listConnections()
      .then((all) => {
        // 프로젝트와 같은 DB 종류의 연결끼리만 비교한다
        const list = all.filter((c) => c.dialect === projectDialect);
        setConnections(list);
        const first = list.find((c) => c.id === projectConnectionId) ?? list[0];
        setSourceId(first?.id ?? '');
        setTargetId(list.find((c) => c.id !== first?.id)?.id ?? '');
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const byId = (id: string) => connections?.find((c) => c.id === id);
  const label = (c: Connection | undefined) => (c ? `${c.name} (${c.host}:${c.port}/${c.database}${c.schema ? `.${c.schema}` : ''})` : '');

  // 대상(target)을 기준(source)과 같게 만드는 계획: 기준을 "ERD", 대상을 "DB" 자리에 둔 내보내기 계획과 같다
  const plan = useMemo(() => (read ? planPush(read.source.schema, read.target.schema, { dialect, links }) : null), [read, dialect, links]);
  useEffect(() => {
    if (plan) setSelected(new Set(plan.defaultSelected));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [read, links]);

  const compare = async () => {
    const source = byId(sourceId);
    const target = byId(targetId);
    if (!source || !target) return;
    setBusy(true);
    setError('');
    try {
      const [s, t] = await Promise.all([
        api.introspect(source.id).catch((e) => Promise.reject(new Error(`기준 DB(${source.name}): ${e instanceof Error ? e.message : String(e)}`))),
        api.introspect(target.id).catch((e) => Promise.reject(new Error(`대상 DB(${target.name}): ${e instanceof Error ? e.message : String(e)}`))),
      ]);
      setLinks([]);
      setRead({ source: s, target: t, sourceName: source.name, targetName: target.name });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const count = (category: 'create' | 'alter' | 'drop') => plan?.diff.changes.filter((c) => c.category === category).length ?? 0;
  const objectsKnown = read && Array.isArray(read.source.schema.objects) && Array.isArray(read.target.schema.objects);

  return (
    <Modal title="DB끼리 비교" onClose={onClose} wide footer={<button className="btn" onClick={onClose}>닫기</button>}>
      <p className="muted small">
        두 DB(예: 개발과 운영)의 테이블·컬럼·인덱스·외래키{dialect.features.objects ? '·뷰·함수 등 객체' : ''}를 읽어 차이를 보여 줍니다. 두 DB 모두 읽기만 하고,
        대상 DB를 기준과 같게 만드는 SQL은 <b>복사·다운로드만</b> 합니다 (실행하지 않음).
      </p>
      {connections && connections.length < 2 && (
        <div className="empty-state">
          비교하려면 {dialect.label} 연결이 2개 이상 있어야 합니다 (지금 {connections.length}개). "DB에서 가져오기" 창에서 연결을 추가하세요.
        </div>
      )}
      {connections && connections.length >= 2 && (
        <div className="compare-pick">
          <label>
            <span>기준 DB <span className="muted small">(맞출 모양, 예: 개발)</span></span>
            <select value={sourceId} onChange={(e) => { setSourceId(e.target.value); setRead(null); }}>
              {connections.map((c) => <option key={c.id} value={c.id}>{label(c)}</option>)}
            </select>
          </label>
          <button className="btn btn-sm compare-swap" title="기준·대상 바꾸기" onClick={() => { setSourceId(targetId); setTargetId(sourceId); setRead(null); }}>⇄</button>
          <label>
            <span>대상 DB <span className="muted small">(바꿀 쪽, 예: 운영)</span></span>
            <select value={targetId} onChange={(e) => { setTargetId(e.target.value); setRead(null); }}>
              {connections.map((c) => <option key={c.id} value={c.id}>{label(c)}</option>)}
            </select>
          </label>
          <button className="btn btn-primary" disabled={busy || !sourceId || !targetId || sourceId === targetId} onClick={compare}>
            {busy ? '읽는 중…' : read ? '다시 비교' : '비교'}
          </button>
        </div>
      )}
      {sourceId && sourceId === targetId && <p className="muted small">서로 다른 두 연결을 고르세요.</p>}
      {error && <div className="error-box">{error}</div>}
      {read && plan && (
        <>
          <div className="import-summary compare-summary">
            <span><b>{read.sourceName}</b> {read.source.serverVersion} · 테이블 {read.source.schema.tables.length}개</span>
            <span>→</span>
            <span><b>{read.targetName}</b> {read.target.serverVersion} · 테이블 {read.target.schema.tables.length}개</span>
          </div>
          {plan.diff.changes.length > 0 && (
            <div className="baseline-info">
              <span className="origin origin-erd">기준에만 있음 {count('create')}건</span>
              <span className="origin origin-conflict">다름 {count('alter')}건</span>
              <span className="origin origin-db">대상에만 있음 {count('drop')}건</span>
              {!objectsKnown && dialect.features.objects && <span className="muted small">뷰·함수 등 객체는 한쪽을 읽지 못해 비교하지 않았습니다</span>}
            </div>
          )}
          <RenamePanel plan={plan} links={links} onChange={setLinks} />
          <MigrationPreview
            diff={plan.diff}
            dialect={dialect}
            selected={selected}
            onSelectedChange={setSelected}
            groups={COMPARE_GROUPS}
            fileName={safeFileName(`${projectName}_${read.targetName}_to_${read.sourceName}`)}
            emptyMessage={`두 DB의 구조가 같습니다.`}
            sqlTitle={`${read.targetName}을(를) ${read.sourceName}과(와) 같게 만드는 SQL`}
          />
        </>
      )}
    </Modal>
  );
}
