import { useState } from 'react';
import { addToArea, createArea, moveToArea, removeFromArea, removeTable, updateTable, type CommentKind } from '@erd/core';
import { selectAreas, useStore } from '../store';
import { copySelection } from '../lib/tableClipboard';
import { TemplateApplyMenu } from './TemplatePanels';
import { ColorPicker, usedColors } from './ColorPicker';
import { Dropdown } from './ui';

/** 테이블을 여러 개 골랐을 때 오른쪽 패널: 색상 일괄 변경, 템플릿, 복사, 삭제 */
export function MultiSelectPanel() {
  const ids = useStore((s) => s.selectedTables);
  const schema = useStore((s) => s.schema);
  const readOnly = useStore((s) => s.role === 'viewer' || Boolean(s.compare));
  // 영역 탭에서는 삭제 대신 '이 영역에서 빼기' (테이블 삭제는 전체 탭에서)
  const inAreaTab = useStore((s) => Boolean(s.activeArea && s.schema.areas?.some((a) => a.id === s.activeArea)));
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
        <ColorPicker allowDefault recent={usedColors(schema.tables.map((t) => t.color))} disabled={readOnly} value={common === null ? null : common || undefined} onChange={(color) => edit((d) => ids.forEach((id) => updateTable(d, id, { color })))} />
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
      <MultiAreaActions ids={ids} readOnly={readOnly} />
      <div className="multi-panel__actions">
        <button className="btn" onClick={() => copySelection()}>복사 (Ctrl+C)</button>
        <TemplateApplyMenu tableIds={ids} disabled={readOnly} />
        {!inAreaTab && <button
          className="btn btn-danger"
          disabled={readOnly}
          onClick={() => {
            if (!confirm(`테이블 ${tables.length}개를 지울까요? (Ctrl+Z로 되돌릴 수 있습니다)`)) return;
            edit((d) => ids.forEach((id) => removeTable(d, id)));
            select(null);
          }}
        >
          삭제
        </button>}
      </div>
      <p className="muted small">
        Shift+끌기로 상자를 그려 여러 개, Ctrl+클릭으로 하나씩 더하거나 뺍니다. 고른 테이블은 함께 끌어 옮길 수 있고, Ctrl+C / Ctrl+V로 복사·붙여넣기합니다.
      </p>
    </aside>
  );
}

/** 고른 테이블들을 주제영역에 넣기·옮기기·빼기, 새 영역으로 묶기 */
function MultiAreaActions({ ids, readOnly }: { ids: string[]; readOnly: boolean }) {
  const areas = useStore(selectAreas);
  const activeArea = useStore((s) => s.activeArea);
  const { edit, setActiveArea, showNotice } = useStore.getState();
  const current = areas.find((a) => a.id === activeArea);
  const others = areas.filter((a) => a.id !== activeArea);
  const done = (text: string) => showNotice({ text: `${text} (Ctrl+Z로 되돌리기)` });
  return (
    <div className="multi-panel__section">
      <h4>주제영역</h4>
      <div className="multi-panel__actions">
        <button
          className="btn"
          disabled={readOnly}
          onClick={() => {
            const name = prompt(`고른 테이블 ${ids.length}개로 새 영역을 만듭니다. 영역 이름`, '새 영역');
            if (!name?.trim()) return;
            let id = '';
            edit((d) => {
              id = createArea(d, { name, tableIds: ids }).id;
            });
            setActiveArea(id);
          }}
        >
          새 영역으로 묶기
        </button>
        {others.length > 0 && (
          <Dropdown
            label="영역에 넣기"
            title="지금 영역에도 그대로 두고 다른 영역에도 보이게"
            items={others.map((a) => ({
              label: a.name,
              disabled: readOnly,
              onClick: () => {
                edit((d) => void addToArea(d, a.id, ids));
                done(`${ids.length}개를 ${a.name} 영역에 넣었습니다`);
              },
            }))}
          />
        )}
        {current && others.length > 0 && (
          <Dropdown
            label="다른 영역으로 옮기기"
            title={`${current.name} 영역에서 빼고 다른 영역으로`}
            items={others.map((a) => ({
              label: `${current.name} → ${a.name}`,
              disabled: readOnly,
              onClick: () => {
                edit((d) => moveToArea(d, a.id, ids, current.id));
                done(`${ids.length}개를 ${a.name} 영역으로 옮겼습니다`);
              },
            }))}
          />
        )}
        {current && (
          <button
            className="btn"
            disabled={readOnly}
            onClick={() => {
              edit((d) => removeFromArea(d, current.id, ids));
              done(`${ids.length}개를 ${current.name} 영역에서 뺐습니다 (테이블은 전체에 남음)`);
            }}
          >
            이 영역에서 빼기
          </button>
        )}
      </div>
    </div>
  );
}
