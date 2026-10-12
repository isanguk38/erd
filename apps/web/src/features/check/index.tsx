// CHECK 제약 기능의 화면 조각: 편집 창의 CHECK 구역. CHECK 모듈(features.check)이 있는 DB에서만 그려진다.

import { createCheck, findTable, type CheckFeature, type Table } from '@erd/core';
import { useStore } from '../../store';
import { requestFocus } from '../../lib/focus';
import { TextInput } from '../../components/TextInput';
import type { FeatureSlots, SlotProps } from '../registry';

/** CHECK 제약: 이름(비우면 ck_테이블_번호)과 조건식 */
function CheckSection({ table }: SlotProps['tableSections'] & { feature: CheckFeature }) {
  const { edit } = useStore.getState();
  const checks = table.checks ?? [];
  const update = (fn: (list: NonNullable<Table['checks']>) => NonNullable<Table['checks']>) =>
    edit((d) => {
      const t = findTable(d, table.id);
      if (!t) return;
      const next = fn(t.checks ?? []);
      if (next.length) t.checks = next;
      else delete t.checks;
    });
  return (
    <div className="inspector__section">
      <div className="inspector__section-head">
        <h4>CHECK 제약 ({checks.length})</h4>
        <button className="btn btn-sm" title="값이 지켜야 할 조건. 예: point >= 0" onClick={() => update((list) => {
          // 새 CHECK의 조건 칸으로 커서를 옮긴다 (버튼에 머물면 스페이스가 버튼을 다시 눌러 빈 CHECK가 생김)
          const check = createCheck({ expression: '' });
          requestFocus(`check:${check.id}`);
          return [...list, check];
        })}>
          + CHECK
        </button>
      </div>
      {checks.length === 0 && <p className="muted">값이 지켜야 할 조건을 걸 수 있습니다. 예) point &gt;= 0, status IN ('READY','DONE')</p>}
      {checks.map((check, i) => (
        <div key={check.id} className="check-row">
          <TextInput
            value={check.name}
            placeholder={`ck_${table.name}_${i + 1}`}
            onCommit={(name) => update((list) => list.map((k) => (k.id === check.id ? { ...k, name: name.trim() } : k)))}
          />
          <TextInput
            className="mono"
            value={check.expression}
            placeholder="조건 예: point >= 0"
            focusKey={`check:${check.id}`}
            onCommit={(expression) => update((list) => list.map((k) => (k.id === check.id ? { ...k, expression: expression.trim().replace(/^check\s*/i, '') } : k)))}
          />
          <button className="icon-btn danger" title="CHECK 삭제" onClick={() => update((list) => list.filter((k) => k.id !== check.id))}>×</button>
        </div>
      ))}
    </div>
  );
}

export const checkUi: FeatureSlots<CheckFeature> = { tableSections: CheckSection };
