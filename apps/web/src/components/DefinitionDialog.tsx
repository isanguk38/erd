import { useMemo, useState } from 'react';
import { diffSchemas, getDialect } from '@erd/core';
import { useStore } from '../store';
import { projectApi } from '../lib/api';
import { useDialect, useProjectName, useVersions, useVersionSchema } from '../lib/hooks';
import { downloadBlob, safeFileName } from '../lib/download';
import { Modal } from './Modal';
import { loadModule } from '../lib/appVersion';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export function DefinitionDialog({ onClose }: { onClose: () => void }) {
  const schema = useStore((s) => s.schema);
  const projectName = useProjectName();
  const dialect = useDialect();
  const versions = useVersions().versions ?? [];
  const projectId = useStore((s) => s.projectId)!;
  const [author, setAuthor] = useState(() => localStorage.getItem('erd-author') ?? '');
  const [version, setVersion] = useState('1.0');
  const [layout, setLayout] = useState<'sheetPerTable' | 'singleSheet'>('sheetPerTable');
  const [historyBase, setHistoryBase] = useState('');
  const [busy, setBusy] = useState(false);
  // 고른 버전 이후 무엇이 바뀌었는지 미리 보여준다
  const baseSchema = useVersionSchema(historyBase || null);
  const preview = useMemo(() => (baseSchema ? diffSchemas(baseSchema, schema, getDialect(dialect)).changes : null), [baseSchema, schema, dialect]);
  const SOURCE = { manual: '직접 저장', auto: '자동', db: 'DB 연동', ai: 'AI' } as const;

  const build = async () => {
    setBusy(true);
    try {
      localStorage.setItem('erd-author', author);
      const { buildDefinitionXlsx } = await loadModule(() => import('@erd/core/excel'));
      const base = historyBase ? await projectApi.version(projectId, historyBase) : undefined;
      const changes = base
        ? { title: `변경 이력 ("${base.name}" 이후)`, items: diffSchemas(base.schema, schema, getDialect(dialect)).changes }
        : undefined;
      const buffer = await buildDefinitionXlsx(schema, { projectName, dialect, author, version, layout, changes });
      downloadBlob(new Blob([buffer], { type: XLSX }), `${safeFileName(projectName)}_테이블정의서.xlsx`);
      onClose();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="테이블 정의서 (Excel)"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>취소</button>
          <button className="btn btn-primary" disabled={busy || !schema.tables.length} onClick={build}>{busy ? '만드는 중…' : '다운로드'}</button>
        </>
      }
    >
      <div className="form-grid wide-label">
        <label>작성자</label>
        <input value={author} onChange={(e) => setAuthor(e.target.value)} placeholder="표지에 들어갑니다" />
        <label>문서 버전</label>
        <input value={version} onChange={(e) => setVersion(e.target.value)} />
        <label>시트 구성</label>
        <div className="segmented">
          <button className={layout === 'sheetPerTable' ? 'active' : ''} onClick={() => setLayout('sheetPerTable')}>테이블마다 시트</button>
          <button className={layout === 'singleSheet' ? 'active' : ''} onClick={() => setLayout('singleSheet')}>한 시트에 모두</button>
        </div>
        <label>변경 이력</label>
        <select value={historyBase} onChange={(e) => setHistoryBase(e.target.value)}>
          <option value="">넣지 않음</option>
          {versions.map((v) => (
            <option key={v.id} value={v.id}>
              "{v.name}" 이후 · {new Date(v.createdAt).toLocaleString()} · {SOURCE[v.source]}
            </option>
          ))}
        </select>
      </div>
      <p className="muted small">
        <b>변경 이력</b>: 저장해 둔 버전을 고르면 그 버전에서 지금까지 바뀐 테이블·컬럼·인덱스·외래키를 "변경 이력" 시트(테이블 목록 바로 다음)에 정리하고,
        표지와 테이블 목록에도 표시합니다. 수정본 정의서를 낼 때 변경 내역으로 쓰세요.
      </p>
      {historyBase && (
        <div className={preview && preview.length === 0 ? 'baseline-info none' : 'baseline-info'}>
          {!preview
            ? '버전을 불러오는 중…'
            : preview.length === 0
              ? '이 버전 이후 바뀐 것이 없습니다. 시트에는 "변경 없음"으로 들어갑니다.'
              : `이 버전 이후 ${preview.length}건 바뀜 (생성 ${preview.filter((c) => c.category === 'create').length} · 수정 ${preview.filter((c) => c.category === 'alter').length} · 삭제 ${preview.filter((c) => c.category === 'drop').length})`}
        </div>
      )}
      <p className="muted small">
        표지 · 테이블 목록(시트 링크){historyBase ? ' · 변경 이력' : ''} · 테이블별 컬럼(논리명/물리명/타입/길이/PK/FK/NULL/기본값/설명) · 인덱스 · 외래키가 들어갑니다. 테이블 {schema.tables.length}개.
      </p>
    </Modal>
  );
}
