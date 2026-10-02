import { createArea, removeTable } from '@erd/core';
import { useStore } from '../store';
import { copySelection } from '../lib/tableClipboard';
import { measuredSizeOf } from '../lib/sizes';
import { TemplateApplyMenu } from './TemplatePanels';

/** 테이블을 여러 개 골랐을 때 오른쪽 패널 */
export function MultiSelectPanel() {
  const ids = useStore((s) => s.selectedTables);
  const schema = useStore((s) => s.schema);
  const readOnly = useStore((s) => s.role === 'viewer' || Boolean(s.compare));
  const { edit, select } = useStore.getState();
  const tables = schema.tables.filter((t) => ids.includes(t.id));

  return (
    <aside className="inspector multi-panel">
      <div className="inspector__head">
        <h3>테이블 {tables.length}개 선택</h3>
        <button className="btn btn-ghost" onClick={() => select(null)}>선택 해제</button>
      </div>
      <ul className="multi-panel__list">
        {tables.map((t) => (
          <li key={t.id}>
            <b>{t.name}</b>
            {t.logicalName && <span className="muted"> {t.logicalName}</span>}
          </li>
        ))}
      </ul>
      <div className="multi-panel__actions">
        <button
          className="btn btn-primary"
          disabled={readOnly}
          onClick={() => {
            const name = prompt('영역 이름', '새 영역');
            if (name === null) return;
            edit((d) => {
              createArea(d, { name: name.trim() || '새 영역', tableIds: ids, sizeOf: measuredSizeOf() });
            });
          }}
        >
          영역으로 묶기
        </button>
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
        Shift+드래그로 상자를 그려 여러 개, Ctrl+클릭으로 하나씩 더 고릅니다. 고른 테이블은 함께 끌어 옮길 수 있고, Ctrl+C / Ctrl+V로 복사·붙여넣기합니다.
      </p>
    </aside>
  );
}
