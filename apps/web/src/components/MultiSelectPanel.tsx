import { useState } from 'react';
import { removeTable, updateTable, type CommentKind } from '@erd/core';
import { useStore } from '../store';
import { copySelection } from '../lib/tableClipboard';
import { TemplateApplyMenu } from './TemplatePanels';
import { TABLE_COLORS } from './Inspector';

/** 테이블을 여러 개 골랐을 때 오른쪽 패널: 색상 일괄 변경, 템플릿, 복사, 삭제 */
export function MultiSelectPanel() {
  const ids = useStore((s) => s.selectedTables);
  const schema = useStore((s) => s.schema);
  const readOnly = useStore((s) => s.role === 'viewer' || Boolean(s.compare));
  const { edit, select, addComments } = useStore.getState();
  const [text, setText] = useState('');
  const [kind, setKind] = useState<CommentKind>('comment');
  const [sent, setSent] = useState('');
  const tables = schema.tables.filter((t) => ids.includes(t.id));
  function submit() {
    if (!text.trim() || readOnly) return;
    addComments(ids, kind, text);
    setText('');
    setSent(`테이블 ${ids.length}개에 남겼습니다`);
  }
  // 모두 같은 색이면 그 색을 표시
  const common = tables.every((t) => (t.color ?? '') === (tables[0]?.color ?? '')) ? tables[0]?.color ?? '' : null;

  return (
    <aside className="inspector multi-panel">
      <div className="inspector__head">
        <h3>테이블 {tables.length}개 선택</h3>
        <button className="btn btn-ghost" onClick={() => select(null)}>선택 해제</button>
      </div>
      <div className="multi-section">
        <h4>색상 한 번에 바꾸기</h4>
        <div className="colors">
          {TABLE_COLORS.map((c) => (
            <button
              key={c || 'default'}
              className={`color-chip${common === c ? ' active' : ''}`}
              style={{ background: c || 'var(--accent)' }}
              title={c ? `${c}로 한 번에 바꾸기` : '기본 색으로'}
              disabled={readOnly}
              onClick={() => edit((d) => ids.forEach((id) => updateTable(d, id, { color: c || undefined })))}
            />
          ))}
        </div>
      </div>
      <div className="comments-section multi-comment">
        <h4>댓글 한 번에 달기</h4>
        <textarea
          value={text}
          rows={2}
          disabled={readOnly}
          placeholder={readOnly ? '보기 권한에서는 댓글을 남길 수 없습니다' : `고른 테이블 ${tables.length}개에 같은 댓글을 남깁니다 (Ctrl+Enter)`}
          onChange={(e) => { setText(e.target.value); setSent(''); }}
          onKeyDown={(e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && submit()}
        />
        <div className="comment-new__row">
          <label className="comment-kind">
            <input type="checkbox" checked={kind === 'review'} disabled={readOnly} onChange={(e) => setKind(e.target.checked ? 'review' : 'comment')} /> 확인 요청
          </label>
          <button className="btn btn-primary small" disabled={readOnly || !text.trim()} onClick={submit}>{tables.length}개에 남기기</button>
        </div>
        {sent && <p className="ok-text small">{sent}</p>}
      </div>
      <ul className="multi-panel__list">
        {tables.map((t) => (
          <li key={t.id}>
            <span className="color-dot" style={{ background: t.color || 'var(--accent)' }} />
            <b>{t.name}</b>
            {t.logicalName && <span className="muted"> {t.logicalName}</span>}
          </li>
        ))}
      </ul>
      <div className="multi-panel__actions">
        <button className="btn" onClick={() => copySelection()}>복사 (Ctrl+C)</button>
        <TemplateApplyMenu tableIds={ids} disabled={readOnly} />
        <button
          className="btn btn-danger"
          disabled={readOnly}
          onClick={() => {
            if (!confirm(`테이블 ${tables.length}개를 지울까요? (Ctrl+Z로 되돌릴 수 있습니다)`)) return;
            edit((d) => ids.forEach((id) => removeTable(d, id)));
            select(null);
          }}
        >
          삭제
        </button>
      </div>
      <p className="muted small">
        Shift+끌기로 상자를 그려 여러 개, Ctrl+클릭으로 하나씩 더하거나 뺍니다. 고른 테이블은 함께 끌어 옮길 수 있고, Ctrl+C / Ctrl+V로 복사·붙여넣기합니다.
      </p>
    </aside>
  );
}
