import { useEffect, useMemo, useState } from 'react';
import { diffSchemas, dialectList, emptySchema, getDialect, type DialectId } from '@erd/core';
import { useStore } from '../store';
import { safeFileName } from '../lib/download';
import { Modal } from './Modal';
import { MigrationPreview } from './MigrationPreview';

type Mode = 'full' | 'changes';

export function SqlDialog({ onClose }: { onClose: () => void }) {
  const schema = useStore((s) => s.schema);
  const versions = useStore((s) => s.versions);
  const projectName = useStore((s) => s.projectName);
  const [dialectId, setDialectId] = useState<DialectId>(useStore.getState().dialect);
  const [mode, setMode] = useState<Mode>(versions.length ? 'changes' : 'full');
  const [baseId, setBaseId] = useState(versions[0]?.id ?? '');
  const dialect = getDialect(dialectId);

  const base = useMemo(
    () => (mode === 'full' ? emptySchema() : versions.find((v) => v.id === baseId)?.schema ?? emptySchema()),
    [mode, baseId, versions],
  );
  const diff = useMemo(() => diffSchemas(base, schema, dialect), [base, schema, dialect]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  useEffect(() => setSelected(new Set(diff.changes.map((c) => c.id))), [diff]);

  const baseVersion = versions.find((v) => v.id === baseId);
  const fileName = safeFileName(mode === 'full' ? `${projectName}_${dialectId}_create` : `${projectName}_${dialectId}_changes`);

  return (
    <Modal title="SQL 추출" onClose={onClose} wide>
      <div className="toolbar-row">
        <div className="segmented">
          <button className={mode === 'full' ? 'active' : ''} onClick={() => setMode('full')}>전체 CREATE</button>
          <button className={mode === 'changes' ? 'active' : ''} onClick={() => setMode('changes')}>변경분만 (ALTER)</button>
        </div>
        <label className="inline-field">
          DB
          <select value={dialectId} onChange={(e) => setDialectId(e.target.value as DialectId)}>
            {dialectList.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
          </select>
        </label>
        {mode === 'changes' && (
          <label className="inline-field">
            기준 버전
            <select value={baseId} onChange={(e) => setBaseId(e.target.value)} disabled={!versions.length}>
              {!versions.length && <option value="">저장된 버전 없음</option>}
              {versions.map((v) => (
                <option key={v.id} value={v.id}>{v.name} · {new Date(v.createdAt).toLocaleString()}</option>
              ))}
            </select>
          </label>
        )}
      </div>
      {mode === 'changes' && !versions.length ? (
        <div className="empty-state">
          비교할 버전이 없습니다. DB에 반영한 시점에 <b>버전 저장</b>을 해 두면, 그 뒤 바뀐 부분만 ALTER로 뽑을 수 있습니다.
        </div>
      ) : (
        <>
          {mode === 'changes' && baseVersion && (
            <p className="muted small">"{baseVersion.name}" 버전 → 지금 ERD 로 가는 SQL입니다. 바뀌지 않은 테이블은 포함되지 않습니다.</p>
          )}
          <MigrationPreview diff={diff} dialect={dialect} selected={selected} onSelectedChange={setSelected} fileName={fileName} />
        </>
      )}
    </Modal>
  );
}
