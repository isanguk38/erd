import { useState } from 'react';
import { useStore } from '../store';
import { projectApi, type VersionInfo } from '../lib/api';
import { saveVersion, useVersions } from '../lib/hooks';
import { Modal } from './Modal';

const SOURCE_LABEL: Record<VersionInfo['source'], string> = { manual: '직접 저장', auto: '자동', db: 'DB 연동', ai: 'AI' };

export function VersionsDialog({ onClose }: { onClose: () => void }) {
  const projectId = useStore((s) => s.projectId)!;
  const { versions, error, reload } = useVersions();
  const [name, setName] = useState('');
  const [showAuto, setShowAuto] = useState(false);

  const list = (versions ?? []).filter((v) => showAuto || v.source !== 'auto');

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
        <button className="btn btn-primary" type="submit">지금 상태 저장</button>
      </form>
      <p className="muted small">
        버전은 서버에 저장되어 함께 작업하는 사람 모두가 봅니다. DB 가져오기·내보내기, AI 작업, 복원 전에는 자동으로 저장됩니다.
      </p>
      <label className="check small">
        <input type="checkbox" checked={showAuto} onChange={(e) => setShowAuto(e.target.checked)} />
        자동 저장 버전도 보기
      </label>
      {error && <div className="error-box">{error}</div>}
      {versions && list.length === 0 && <div className="empty-state">저장된 버전이 없습니다.</div>}
      <ul className="version-list">
        {list.map((v) => (
          <li key={v.id}>
            <div>
              <b>{v.name}</b>
              <div className="muted small">
                {new Date(v.createdAt).toLocaleString()} · {SOURCE_LABEL[v.source]} · 테이블 {v.tableCount}개
              </div>
            </div>
            <div className="btn-row">
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
