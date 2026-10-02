import { useEffect, useState } from 'react';
import { applyTemplate, getDialect, newId, sampleTemplates, type ColumnTemplate, type DialectId, type TemplateColumn } from '@erd/core';
import { useStore } from '../store';
import { useTemplates } from '../lib/templates';
import { Modal } from './Modal';
import { Dropdown } from './ui';

const emptyColumn = (): TemplateColumn => ({ name: '', logicalName: '', type: 'VARCHAR', length: '', nullable: true, primaryKey: false, autoIncrement: false, defaultValue: null, comment: '' });

/** 고른 테이블에 템플릿 넣기 (오른쪽 패널) */
export function TemplateApplyMenu({ tableIds, disabled }: { tableIds: string[]; disabled?: boolean }) {
  const { templates, load } = useTemplates();
  useEffect(() => void load(), [load]);
  return (
    <Dropdown
      label="템플릿 적용"
      title="고른 테이블에 공통 컬럼 템플릿을 넣습니다 (같은 이름 컬럼은 건너뜀)"
      items={
        templates.length
          ? templates.map((t) => ({
              label: t.name,
              hint: [...t.top, ...t.bottom].map((c) => c.name).join(', '),
              disabled,
              onClick: () => {
                let added = 0;
                let skipped = 0;
                useStore.getState().edit((d) => {
                  for (const id of tableIds) {
                    const r = applyTemplate(d, id, t);
                    added += r.added.length;
                    skipped += r.skipped.length;
                  }
                });
                if (skipped) alert(`컬럼 ${added}개를 넣었습니다. ${skipped}개는 같은 이름이 이미 있거나 기본키가 이미 있어 건너뛰었습니다.`);
              },
            }))
          : [{ label: '템플릿이 없습니다', hint: '+ 테이블 ▾ → 컬럼 템플릿 관리', disabled: true, onClick: () => {} }]
      }
    />
  );
}

/** 컬럼 템플릿 관리 (내 계정에 저장, 모든 프로젝트 공용) */
export function TemplateManagerDialog({ onClose }: { onClose: () => void }) {
  const state = useTemplates();
  const dialect = useStore((s) => s.meta.dialect) as DialectId;
  const [templates, setTemplates] = useState<ColumnTemplate[]>([]);
  const [defaultId, setDefaultId] = useState<string | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => void state.load(), [state.load]);
  useEffect(() => {
    if (!state.loaded) return;
    setTemplates(structuredClone(state.templates));
    setDefaultId(state.defaultTemplateId);
    setCurrent(state.templates[0]?.id ?? null);
  }, [state.loaded]);

  const tpl = templates.find((t) => t.id === current) ?? null;
  const change = (fn: (t: ColumnTemplate) => void) => {
    setTemplates((list) => list.map((t) => (t.id === current ? (() => { const c = structuredClone(t); fn(c); return c; })() : t)));
    setDirty(true);
  };
  const add = (t: ColumnTemplate) => {
    const copy = { ...structuredClone(t), id: newId('tpl') };
    setTemplates((list) => [...list, copy]);
    setCurrent(copy.id);
    setDirty(true);
  };
  const save = async () => {
    setSaving(true);
    try {
      await state.save({ templates, defaultTemplateId: defaultId });
      setDirty(false);
      onClose();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };
  const types = (() => {
    try {
      return getDialect(dialect).typeSuggestions;
    } catch {
      return [];
    }
  })();

  const section = (key: 'top' | 'bottom', title: string, hint: string) =>
    tpl && (
      <div className="tpl-section">
        <div className="inspector__section-head">
          <h4>{title} <span className="muted small">{hint}</span></h4>
          <button className="btn btn-ghost" onClick={() => change((t) => t[key].push(emptyColumn()))}>+ 컬럼</button>
        </div>
        {tpl[key].length === 0 ? (
          <p className="muted small">없음</p>
        ) : (
          <table className="tpl-table">
            <thead>
              <tr><th>물리명</th><th>논리명</th><th>타입</th><th>길이</th><th title="기본키">PK</th><th title="NOT NULL">NN</th><th title="자동 증가">AI</th><th>기본값</th><th /></tr>
            </thead>
            <tbody>
              {tpl[key].map((c, i) => (
                <tr key={i}>
                  <td><input value={c.name} placeholder="created_at" onChange={(e) => change((t) => (t[key][i].name = e.target.value))} /></td>
                  <td><input value={c.logicalName} placeholder="생성일시" onChange={(e) => change((t) => (t[key][i].logicalName = e.target.value))} /></td>
                  <td><input value={c.type} list="tpl-types" onChange={(e) => change((t) => (t[key][i].type = e.target.value.toUpperCase()))} /></td>
                  <td><input className="narrow" value={c.length} onChange={(e) => change((t) => (t[key][i].length = e.target.value))} /></td>
                  <td><input type="checkbox" checked={c.primaryKey} onChange={(e) => change((t) => { t[key][i].primaryKey = e.target.checked; if (e.target.checked) t[key][i].nullable = false; })} /></td>
                  <td><input type="checkbox" checked={!c.nullable} disabled={c.primaryKey} onChange={(e) => change((t) => (t[key][i].nullable = !e.target.checked))} /></td>
                  <td><input type="checkbox" checked={c.autoIncrement} onChange={(e) => change((t) => (t[key][i].autoIncrement = e.target.checked))} /></td>
                  <td><input value={c.defaultValue ?? ''} placeholder="NULL" onChange={(e) => change((t) => (t[key][i].defaultValue = e.target.value || null))} /></td>
                  <td><button className="icon-btn" title="빼기" onClick={() => change((t) => t[key].splice(i, 1))}>×</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    );

  return (
    <Modal
      title="컬럼 템플릿"
      wide
      onClose={() => (!dirty || confirm('저장하지 않은 변경이 있습니다. 닫을까요?')) && onClose()}
      footer={
        <>
          <button className="btn" onClick={onClose}>취소</button>
          <button className="btn btn-primary" disabled={saving || !dirty} onClick={save}>{saving ? '저장 중…' : '저장'}</button>
        </>
      }
    >
      <datalist id="tpl-types">{types.map((t) => <option key={t} value={t} />)}</datalist>
      <p className="muted small">
        자주 쓰는 공통 컬럼(번호, 생성·수정일시 등)을 내 규격대로 만들어 두고 테이블에 넣습니다. 내 계정에 저장되어 모든 프로젝트에서 씁니다.
        "새 테이블 기본"으로 정한 템플릿은 새 테이블을 만들 때 자동으로 들어갑니다.
      </p>
      {!state.loaded ? (
        <p className="muted">{state.error || '불러오는 중…'}</p>
      ) : (
        <div className="tpl-layout">
          <div className="tpl-list">
            {templates.map((t) => (
              <button key={t.id} className={t.id === current ? 'active' : ''} onClick={() => setCurrent(t.id)}>
                <span>{t.name}</span>
                {t.id === defaultId && <span className="tag">기본</span>}
              </button>
            ))}
            <button className="btn btn-ghost" onClick={() => add({ id: '', name: '새 템플릿', top: [], bottom: [] })}>+ 새 템플릿</button>
            <div className="tpl-samples">
              <span className="muted small">예시로 시작:</span>
              {sampleTemplates().map((s) => (
                <button key={s.id} className="btn btn-ghost small" onClick={() => add(s)}>{s.name}</button>
              ))}
            </div>
          </div>
          <div className="tpl-edit">
            {tpl ? (
              <>
                <div className="tpl-head">
                  <input className="tpl-name" value={tpl.name} onChange={(e) => change((t) => (t.name = e.target.value))} />
                  <label className="tpl-default">
                    <input type="checkbox" checked={defaultId === tpl.id} onChange={(e) => { setDefaultId(e.target.checked ? tpl.id : null); setDirty(true); }} />
                    새 테이블 기본
                  </label>
                  <button
                    className="btn btn-ghost btn-danger-text"
                    onClick={() => {
                      setTemplates((list) => list.filter((t) => t.id !== tpl.id));
                      if (defaultId === tpl.id) setDefaultId(null);
                      setCurrent(templates.find((t) => t.id !== tpl.id)?.id ?? null);
                      setDirty(true);
                    }}
                  >
                    템플릿 삭제
                  </button>
                </div>
                {section('top', '맨 앞 컬럼', '(예: id)')}
                {section('bottom', '맨 뒤 컬럼', '(예: created_at, updated_at)')}
                <p className="muted small">테이블에 넣을 때 같은 이름의 컬럼이 이미 있으면 건너뛰고, 기본키가 이미 있으면 템플릿의 기본키 컬럼은 넣지 않습니다.</p>
              </>
            ) : (
              <p className="muted">왼쪽에서 템플릿을 고르거나 새로 만드세요.</p>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
