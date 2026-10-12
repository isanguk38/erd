import { useEffect, useRef, useState } from 'react';
import { addEnumType, enumKey, enumUsages, removeEnumType, updateEnumType, type EnumType } from '@erd/core';
import { useStore } from '../../store';
import { Modal } from '../../components/Modal';


const lines = (text: string) => text.split('\n').map((v) => v.trim()).filter(Boolean);

/** 사용자 정의 타입(ENUM) 관리: 만들기·이름·값 고치기·지우기. 컬럼 타입 칸에 이름을 적어 쓴다 */
export function EnumDialog({ onClose, focus, create: createName, help }: { onClose: () => void; focus?: string; create?: string; help: string }) {
  const enums = useStore((s) => s.schema.enums);
  const schema = useStore((s) => s.schema);
  const readOnly = useStore((s) => s.role === 'viewer' || Boolean(s.compare));
  const { edit, showNotice } = useStore.getState();
  // 컬럼 타입 칸에서 "타입으로 만들기"로 열면 이름을 채워 둔다
  const [name, setName] = useState(createName ?? '');
  const [values, setValues] = useState('');

  const create = () => {
    let made: EnumType | undefined;
    edit((d) => void (made = addEnumType(d, { name, values: lines(values) })));
    if (!made) return;
    setName('');
    setValues('');
    showNotice({ text: `타입 ${made.name}을(를) 만들었습니다 — 컬럼 타입 칸에 ${made.name}을(를) 적어 쓰세요` });
  };

  return (
    <Modal title="사용자 정의 타입 (ENUM)" onClose={onClose} wide>
      <p className="muted small enum-help">
        상태·구분처럼 값이 정해진 컬럼에 씁니다. 타입을 만든 뒤 컬럼의 타입 칸에 이름을 적으세요. {help}
      </p>
      {!readOnly && (
        <div className="enum-new">
          <label>
            <span>이름</span>
            <input value={name} placeholder="예: order_status" onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            <span>값 (한 줄에 하나, 순서대로)</span>
            <textarea rows={3} autoFocus={Boolean(createName)} value={values} placeholder={'READY\nPAID\nCANCELED'} onChange={(e) => setValues(e.target.value)} />
          </label>
          <button className="btn btn-primary" disabled={!name.trim() || !lines(values).length} onClick={create}>
            + 타입 만들기
          </button>
        </div>
      )}
      {!enums?.length ? (
        <p className="muted enum-empty">아직 만든 타입이 없습니다.</p>
      ) : (
        <ul className="enum-list">
          {enums.map((e) => (
            <EnumRow key={e.id} item={e} usages={enumUsages(schema, e).map((u) => `${u.table}.${u.column.name}`)} readOnly={readOnly} focused={Boolean(focus) && enumKey(focus!) === enumKey(e.name)} />
          ))}
        </ul>
      )}
    </Modal>
  );
}

function EnumRow({ item, usages, readOnly, focused }: { item: EnumType; usages: string[]; readOnly: boolean; focused?: boolean }) {
  const { edit, showNotice } = useStore.getState();
  // 컬럼 타입 칸에서 열었으면 그 타입 카드로 스크롤하고 값 칸에 커서를 둔다
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (!focused) return;
    ref.current?.scrollIntoView({ block: 'nearest' });
    ref.current?.querySelector('textarea')?.focus();
  }, [focused]);
  const [name, setName] = useState<string | null>(null);
  const [values, setValues] = useState<string | null>(null);
  const update = (patch: { name?: string; values?: string[]; comment?: string }) => edit((d) => void updateEnumType(d, item.id, patch));
  const commitName = () => {
    if (name !== null && name.trim() !== item.name) update({ name });
    setName(null);
  };
  const commitValues = () => {
    if (values !== null && lines(values).join('\n') !== item.values.join('\n')) {
      const removed = item.values.filter((v) => !lines(values).includes(v));
      if (removed.length && usages.length && !confirm(`값 ${removed.join(', ')}을(를) 뺍니다. 이 값을 쓰는 행이 있으면 DB로 내보낼 때 실패합니다.\n쓰는 컬럼: ${usages.join(', ')}\n계속할까요?`)) {
        setValues(null);
        return;
      }
      update({ values: lines(values) });
    }
    setValues(null);
  };
  const remove = () => {
    const text = usages.length
      ? `타입 ${item.name}을(를) 지웁니다. 이 타입을 쓰는 컬럼 ${usages.length}개(${usages.join(', ')})는 VARCHAR로 바뀝니다.\n계속할까요? (Ctrl+Z로 되돌릴 수 있음)`
      : `타입 ${item.name}을(를) 지울까요? (Ctrl+Z로 되돌릴 수 있음)`;
    if (!confirm(text)) return;
    edit((d) => void removeEnumType(d, item.id));
    showNotice({ text: `타입 ${item.name}을(를) 지웠습니다 (Ctrl+Z로 되돌리기)` });
  };
  return (
    <li className={`enum-row${focused ? ' focused' : ''}`} ref={ref}>
      <div className="enum-row__head">
        <input
          className="mono enum-row__name"
          value={name ?? item.name}
          disabled={readOnly}
          aria-label="타입 이름"
          onChange={(e) => setName(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') setName(null);
          }}
        />
        <span className="muted small" title={usages.join('\n') || undefined}>
          {usages.length ? `쓰는 컬럼 ${usages.length}개` : '쓰는 컬럼 없음'}
        </span>
        {!readOnly && (
          <button className="btn btn-ghost small danger" onClick={remove} title="타입 지우기 (쓰던 컬럼은 VARCHAR로)">
            삭제
          </button>
        )}
      </div>
      <textarea
        className="mono enum-row__values"
        rows={Math.min(8, Math.max(2, (values ?? item.values.join('\n')).split('\n').length))}
        value={values ?? item.values.join('\n')}
        disabled={readOnly}
        aria-label={`${item.name} 값`}
        onChange={(e) => setValues(e.target.value)}
        onBlur={commitValues}
      />
      {usages.length > 0 && <p className="muted small enum-row__usages">{usages.join(', ')}</p>}
    </li>
  );
}
