import { useMemo, useState } from 'react';
import { diffSchemas, getDialect } from '@erd/core';
import { useStore } from '../store';
import { projectApi } from '../lib/api';
import { saveVersion, useDialect, useVersions, useVersionSchema } from '../lib/hooks';
import { VERSION_KIND, versionTime } from '../lib/versions';
import { Modal } from './Modal';

export function VersionsDialog({ onClose }: { onClose: () => void }) {
  const projectId = useStore((s) => s.projectId)!;
  const schema = useStore((s) => s.schema);
  const dialect = getDialect(useDialect());
  const { versions, error, reload } = useVersions();
  const [name, setName] = useState('');
  const [showAuto, setShowAuto] = useState(false);

  const list = (versions ?? []).filter((v) => showAuto || v.source !== 'auto');
  // 지금 ERD가 가장 최근 버전과 같은지 (같으면 그 버전에 "지금과 같음" 표시). 작업 직전 자동 백업은 빼고 본다
  const latest = versions?.find((v) => v.source !== 'auto');
  const latestSchema = useVersionSchema(latest?.id ?? null);
  const changedSinceLatest = useMemo(() => (latestSchema ? diffSchemas(latestSchema, schema, dialect).changes.length : null), [latestSchema, schema, dialect]);
  const latestIsCurrent = changedSinceLatest === 0;

  return (
    <Modal title="버전" onClose={onClose}>
      <form
        className="toolbar-row"
        onSubmit={async (e) => {
          e.preventDefault();
          await saveVersion(name.trim() || new Date().toLocaleString());
          setName('');
          reload();
        }}
      >
        <input className="grow" value={name} onChange={(e) => setName(e.target.value)} placeholder="버전 이름 (예: 운영 DB 반영 2026-10-01)" />
        <button className="btn btn-primary" type="submit">지금 상태를 버전으로 저장</button>
      </form>
      <p className="muted small">
        ERD는 고칠 때마다 <b>실시간으로 저장</b>되므로 따로 저장하지 않아도 됩니다. <b>버전</b>은 어느 시점을 사진처럼 남겨 두는 것으로, 나중에 비교·복원하거나
        그 시점부터 바뀐 SQL을 뽑을 때 씁니다. 직접 저장할 수 있고, DB 가져오기·내보내기·AI 작업·복원 직전에는 자동으로 남습니다.
      </p>

      {/* 지금 ERD: 버전 목록과 구분해 맨 위에 고정 */}
      <div className="version-current">
        <span className="version-current__dot" />
        <div className="grow">
          <b>지금 ERD</b> <span className="version-kind version-kind--current">작업 중 · 실시간 저장</span>
          <div className="muted small">
            {!latest
              ? '아직 저장된 버전이 없습니다.'
              : changedSinceLatest === null
                ? '최근 버전과 비교하는 중…'
                : latestIsCurrent
                  ? `가장 최근 버전 "${latest.name}"과 같습니다.`
                  : `가장 최근 버전 "${latest.name}" 이후 ${changedSinceLatest}건 바뀌었습니다. 이 상태를 남기려면 위에서 버전으로 저장하세요.`}
          </div>
        </div>
      </div>

      <div className="version-list__head">
        <span className="muted small">저장된 버전 (최신순)</span>
        <label className="check small">
          <input type="checkbox" checked={showAuto} onChange={(e) => setShowAuto(e.target.checked)} />
          작업 직전 자동 백업도 보기
        </label>
      </div>
      {error && <div className="error-box">{error}</div>}
      {versions && list.length === 0 && <div className="empty-state">저장된 버전이 없습니다.</div>}
      <ul className="version-list">
        {list.map((v) => (
          <li key={v.id}>
            <div>
              <b>{v.name}</b> <span className={`version-kind version-kind--${v.source}`} title={VERSION_KIND[v.source].hint}>{VERSION_KIND[v.source].label}</span>
              {v.id === latest?.id && latestIsCurrent && <span className="version-kind version-kind--same" title="지금 ERD와 내용이 같습니다">지금과 같음</span>}
              <div className="muted small">
                {versionTime(v)} · 테이블 {v.tableCount}개
              </div>
            </div>
            <div className="btn-row">
              <button
                className="btn btn-sm btn-primary"
                onClick={async () => {
                  const full = await projectApi.version(projectId, v.id);
                  useStore.getState().setCompare({ name: v.name, createdAt: v.createdAt, schema: full.schema });
                  onClose();
                }}
              >
                지금과 비교
              </button>
              <button
                className="btn btn-sm"
                onClick={async () => {
                  if (!confirm(`"${v.name}" 버전으로 되돌릴까요? 지금 상태는 자동으로 버전에 저장됩니다.`)) return;
                  await projectApi.restoreVersion(projectId, v.id);
                  onClose();
                }}
              >
                이 버전으로 복원
              </button>
              <button
                className="btn btn-sm btn-danger"
                onClick={async () => {
                  if (!confirm(`"${v.name}" 버전을 삭제할까요?`)) return;
                  await projectApi.deleteVersion(projectId, v.id);
                  reload();
                }}
              >
                삭제
              </button>
            </div>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
