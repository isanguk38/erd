import { useEffect, useMemo, useState } from 'react';
import { diffSchemas, dialectList, emptySchema, getDialect, type DialectId } from '@erd/core';
import { useStore } from '../store';
import { useDialect, useProjectName, useVersions, useVersionSchema } from '../lib/hooks';
import { safeFileName } from '../lib/download';
import { defaultBaseVersion, VERSION_GROUPS, VERSION_KIND, versionTime } from '../lib/versions';
import { Modal } from './Modal';
import { MigrationPreview } from './MigrationPreview';

type Mode = 'full' | 'changes';

export function SqlDialog({ onClose }: { onClose: () => void }) {
  const schema = useStore((s) => s.schema);
  const versions = useVersions().versions ?? [];
  const projectName = useProjectName();
  const projectDialect = useDialect();
  const [dialectId, setDialectId] = useState<DialectId>(projectDialect);
  const [mode, setMode] = useState<Mode>('full');
  const [pickedId, setPickedId] = useState('');
  // 기본 시작점: 마지막으로 DB와 맞춘 버전 (그 뒤 ERD에서 바꾼 것 = DB에 아직 안 간 것)
  const baseId = pickedId || defaultBaseVersion(versions)?.id || '';
  const setBaseId = setPickedId;
  const dialect = getDialect(dialectId);
  const versionSchema = useVersionSchema(mode === 'changes' ? baseId : null);

  const base = useMemo(() => (mode === 'full' ? emptySchema() : versionSchema ?? emptySchema()), [mode, versionSchema]);
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
          <label className="inline-field" title="고른 버전(그 시점의 ERD)에서 지금 ERD까지 바뀐 부분을 SQL로 만듭니다">
            어느 버전부터
            <select value={baseId} onChange={(e) => setBaseId(e.target.value)} disabled={!versions.length}>
              {!versions.length && <option value="">저장된 버전 없음</option>}
              {VERSION_GROUPS.map((g) => {
                const items = versions.filter((v) => g.sources.includes(v.source));
                if (!items.length) return null;
                return (
                  <optgroup key={g.title} label={g.title}>
                    {items.map((v) => (
                      <option key={v.id} value={v.id}>{v.name} · {versionTime(v)}</option>
                    ))}
                  </optgroup>
                );
              })}
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
            <p className="muted small">
              <b>{baseVersion.name}</b> ({VERSION_KIND[baseVersion.source].label}, {versionTime(baseVersion)}) 시점의 ERD → <b>지금 ERD</b>로 가는 SQL입니다.
              바뀌지 않은 테이블은 포함되지 않습니다.
            </p>
          )}
          {mode === 'changes' && !versionSchema ? <div className="muted">버전을 불러오는 중…</div> : <MigrationPreview diff={diff} dialect={dialect} selected={selected} onSelectedChange={setSelected} fileName={fileName} />}
        </>
      )}
    </Modal>
  );
}
