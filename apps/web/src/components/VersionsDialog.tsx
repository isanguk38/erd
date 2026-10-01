import { useState } from 'react';
import { cloneSchema, diffSchemas, getDialect } from '@erd/core';
import { useStore } from '../store';
import { Modal } from './Modal';

export function VersionsDialog({ onClose }: { onClose: () => void }) {
  const versions = useStore((s) => s.versions);
  const schema = useStore((s) => s.schema);
  const dialect = getDialect(useStore((s) => s.dialect));
  const { saveVersion, deleteVersion, replaceSchema } = useStore.getState();
  const [name, setName] = useState('');

  return (
    <Modal title="버전" onClose={onClose}>
      <form
        className="toolbar-row"
        onSubmit={(e) => {
          e.preventDefault();
          saveVersion(name.trim() || new Date().toLocaleString());
          setName('');
        }}
      >
        <input className="grow" value={name} onChange={(e) => setName(e.target.value)} placeholder="버전 이름 (예: 운영 DB 반영 2026-10-01)" />
        <button className="btn btn-primary" type="submit">지금 상태 저장</button>
      </form>
      <p className="muted small">DB에 반영한 시점마다 버전을 저장해 두면 SQL 추출의 "변경분만"에서 그 이후 바뀐 부분만 ALTER로 뽑을 수 있습니다.</p>
      {versions.length === 0 && <div className="empty-state">저장된 버전이 없습니다.</div>}
      <ul className="version-list">
        {versions.map((v) => {
          const changes = diffSchemas(v.schema, schema, dialect).changes.length;
          return (
            <li key={v.id}>
              <div>
                <b>{v.name}</b>
                <div className="muted small">
                  {new Date(v.createdAt).toLocaleString()} · 테이블 {v.schema.tables.length}개 · 지금과 {changes ? `${changes}건 다름` : '같음'}
                </div>
              </div>
              <div className="btn-row">
                <button
                  className="btn btn-sm"
                  onClick={() => {
                    if (!confirm(`"${v.name}" 버전으로 되돌릴까요? (되돌리기로 취소할 수 있습니다)`)) return;
                    replaceSchema(cloneSchema(v.schema));
                    onClose();
                  }}
                >
                  이 버전으로 복원
                </button>
                <button className="btn btn-sm btn-danger" onClick={() => confirm(`"${v.name}" 버전을 삭제할까요?`) && deleteVersion(v.id)}>삭제</button>
              </div>
            </li>
          );
        })}
      </ul>
    </Modal>
  );
}
