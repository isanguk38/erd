import { useMemo, useState } from 'react';
import { applyChanges, diffIncoming, getDialect, parseDdl, placeNewTables, type DdlImportResult, type DialectId } from '@erd/core';
import { useStore } from '../store';
import { Modal } from './Modal';
import { ChangeList, type GroupLabel } from './ChangeList';

type Mode = 'replace' | 'merge';

const MERGE_GROUPS: Record<'create' | 'alter' | 'drop', GroupLabel> = {
  create: { title: '추가', hint: 'ERD에 없는 테이블' },
  alter: { title: '수정', hint: 'ERD에 있는 테이블의 변경' },
  drop: { title: '삭제', hint: '' },
};

export function ImportDialog({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const current = useStore((s) => s.schema);
  const projectDialect = useStore((s) => s.dialect);
  const [sql, setSql] = useState('');
  const [dialect, setDialect] = useState<DialectId | 'auto'>('auto');
  const [commentAs, setCommentAs] = useState<'logicalName' | 'comment'>('logicalName');
  const [mode, setMode] = useState<Mode>(current.tables.length ? 'merge' : 'replace');
  const [result, setResult] = useState<DdlImportResult | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  // 합치기: DDL에 없는 테이블은 지우지 않는다 (삭제 변경 제외)
  const diff = useMemo(() => {
    if (!result || mode !== 'merge') return null;
    const d = diffIncoming(current, result.schema, getDialect(result.dialect));
    return { ...d, changes: d.changes.filter((c) => c.kind !== 'dropTable' && c.kind !== 'dropForeignKey') };
  }, [result, mode, current]);

  const read = () => {
    const r = parseDdl(sql, { dialect, commentAs, context: mode === 'merge' ? current : undefined });
    setResult(r);
    const d = diffIncoming(current, r.schema, getDialect(r.dialect));
    setSelected(new Set(d.changes.map((c) => c.id)));
  };

  const apply = async () => {
    if (!result) return;
    setBusy(true);
    try {
      const { replaceSchema, setDialect: setProjectDialect } = useStore.getState();
      if (mode === 'replace') {
        const schema = structuredClone(result.schema);
        const { autoLayout } = await import('@erd/core/layout');
        const positions = await autoLayout(schema);
        for (const t of schema.tables) t.position = positions.get(t.id) ?? t.position;
        replaceSchema(schema);
        if (schema.tables.length) setProjectDialect(result.dialect);
      } else if (diff) {
        const next = applyChanges(current, diff, selected);
        const created = diff.changes.flatMap((c) => (c.kind === 'createTable' && selected.has(c.id) ? [c.table.id] : []));
        placeNewTables(next, created);
        replaceSchema(next);
      }
      onImported();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const loadFile = async (file: File) => setSql(await file.text());

  return (
    <Modal
      title="SQL 가져오기 (DDL → ERD)"
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>취소</button>
          <button
            className="btn btn-primary"
            disabled={!result || busy || !result.schema.tables.length || (mode === 'merge' && !selected.size)}
            onClick={apply}
          >
            {mode === 'replace' ? 'ERD 새로 만들기' : `선택한 ${selected.size}건 반영`}
          </button>
        </>
      }
    >
      <div className="toolbar-row">
        <label className="inline-field">
          문법
          <select value={dialect} onChange={(e) => { setDialect(e.target.value as DialectId | 'auto'); setResult(null); }}>
            <option value="auto">자동 감지</option>
            <option value="mysql">MySQL</option>
            <option value="postgresql">PostgreSQL</option>
          </select>
        </label>
        <label className="inline-field">
          DB 코멘트를
          <select value={commentAs} onChange={(e) => { setCommentAs(e.target.value as 'logicalName' | 'comment'); setResult(null); }}>
            <option value="logicalName">논리명으로</option>
            <option value="comment">설명으로</option>
          </select>
        </label>
        <div className="segmented">
          <button className={mode === 'merge' ? 'active' : ''} onClick={() => { setMode('merge'); setResult(null); }} disabled={!current.tables.length}>지금 ERD에 합치기</button>
          <button className={mode === 'replace' ? 'active' : ''} onClick={() => { setMode('replace'); setResult(null); }}>새로 만들기</button>
        </div>
        <label className="btn">
          .sql 파일 열기
          <input type="file" accept=".sql,.txt,.ddl" hidden onChange={(e) => e.target.files?.[0] && loadFile(e.target.files[0])} />
        </label>
      </div>

      {!result ? (
        <>
          <textarea
            className="sql-input"
            value={sql}
            onChange={(e) => setSql(e.target.value)}
            spellCheck={false}
            placeholder={'CREATE TABLE, CREATE INDEX, ALTER TABLE ... ADD CONSTRAINT, COMMENT ON 문을 붙여넣으세요.\nmysqldump --no-data 또는 pg_dump --schema-only 결과를 그대로 넣어도 됩니다.'}
          />
          <div className="btn-row">
            <button className="btn btn-primary" disabled={!sql.trim()} onClick={read}>읽기</button>
          </div>
        </>
      ) : (
        <>
          <div className="import-summary">
            <b>{getDialect(result.dialect).label}</b> 문법으로 테이블 {result.schema.tables.length}개, 관계 {result.schema.relations.length}개를 읽었습니다.
            {result.dialect !== projectDialect && mode === 'merge' && <span className="warning-inline"> 프로젝트 DB({getDialect(projectDialect).label})와 다릅니다.</span>}
            <button className="btn btn-sm" onClick={() => setResult(null)}>SQL 다시 편집</button>
          </div>
          {result.warnings.length > 0 && (
            <details className="import-warnings">
              <summary>건너뛴 문장 {result.warnings.length}개</summary>
              <ul>{result.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
            </details>
          )}
          {mode === 'replace' ? (
            <p className="muted">지금 ERD를 지우고 읽은 테이블로 새로 그립니다. 배치는 관계를 보고 자동으로 정합니다. (되돌리기 가능)</p>
          ) : diff && diff.changes.length === 0 ? (
            <div className="empty-state">지금 ERD와 같습니다. 반영할 변경이 없습니다.</div>
          ) : (
            diff && (
              <>
                <p className="muted small">같은 이름의 테이블·컬럼은 같은 것으로 봅니다. 위치·색상과 (DDL에 코멘트가 없으면) 논리명은 그대로 둡니다. DDL에 없는 테이블은 지우지 않습니다.</p>
                <ChangeList changes={diff.changes} selected={selected} onSelectedChange={setSelected} groups={MERGE_GROUPS} />
              </>
            )
          )}
        </>
      )}
    </Modal>
  );
}
