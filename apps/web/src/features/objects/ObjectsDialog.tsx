import { useEffect, useMemo, useState } from 'react';
import { addObject, cloneSchema, DB_OBJECT_LABEL, parseObjectDdl, removeObject, updateObject, type DbObject, type DbObjectKind, type DbObjectsFeature } from '@erd/core';
import { useStore } from '../../store';
import { Modal } from '../../components/Modal';

/** 새로 만들 때 겹치지 않는 이름 */
const freshName = (kind: DbObjectKind, taken: DbObject[]) => {
  const base = { view: 'v_new', materializedView: 'mv_new', function: 'fn_new', procedure: 'sp_new', trigger: 'trg_new', event: 'ev_new', package: 'pkg_new', packageBody: 'pkg_new' }[kind];
  const names = new Set(taken.filter((o) => o.kind === kind).map((o) => o.name.toLowerCase()));
  if (!names.has(base)) return base;
  for (let i = 2; ; i++) if (!names.has(`${base}${i}`)) return `${base}${i}`;
};

/**
 * DB 객체 창: 뷰·함수·프로시저·트리거·이벤트·패키지를 DDL 그대로 보고 고친다.
 * 저장하면 ERD에만 반영되고, DB에는 "DB로 내보내기"에서 바뀐 것만 지웠다 다시 만든다.
 * DB에서 가져오기로 DB에 있는 객체를 가져온다. 어떤 종류를 다룰 수 있는지는 프로젝트 DB의 objects 모듈이 정한다.
 */
export function ObjectsDialog({ feature, focus, onClose }: { feature: DbObjectsFeature; focus?: string; onClose: () => void }) {
  const objects = useStore((s) => s.schema.objects ?? []);
  const firstTable = useStore((s) => s.schema.tables[0]?.name);
  const readOnly = useStore((s) => s.role === 'viewer');
  const [selected, setSelected] = useState<string | null>(focus ?? objects[0]?.id ?? null);
  // 새로 만드는 중이면 아직 저장 안 한 DDL (selected = 'new')
  const [draft, setDraft] = useState('');
  const [comment, setComment] = useState('');
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const current = objects.find((o) => o.id === selected) ?? null;
  const isNew = selected === 'new';

  // 고른 객체가 바뀌면 그 DDL로
  useEffect(() => {
    if (isNew) return;
    setDraft(current?.definition ?? '');
    setComment(current?.comment ?? '');
    setError('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, current?.definition]);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    return feature.kinds
      .map((kind) => ({ kind, items: objects.filter((o) => o.kind === kind && (!q || o.name.toLowerCase().includes(q) || (o.table ?? '').toLowerCase().includes(q))) }))
      .filter((g) => g.items.length || !q);
  }, [objects, feature.kinds, query]);

  const startNew = (kind: DbObjectKind) => {
    setSelected('new');
    setDraft(feature.template(kind, freshName(kind, objects), firstTable));
    setComment('');
    setError('');
  };

  const header = parseObjectDdl(draft);
  const dirty = isNew || (current && (draft !== current.definition || comment !== (current.comment ?? '')));

  const save = () => {
    // 먼저 사본에 해 보고, 되면 저장한다 (오류는 창 안에 보인다)
    try {
      const test = cloneSchema(useStore.getState().schema);
      if (isNew) addObject(test, draft, feature.kinds);
      else if (current) updateObject(test, current.id, { definition: draft, comment }, feature.kinds);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    let createdId = '';
    useStore.getState().edit((d) => {
      if (isNew) {
        const o = addObject(d, draft, feature.kinds);
        if (comment.trim()) o.comment = comment.trim();
        createdId = o.id;
      } else if (current) {
        updateObject(d, current.id, { definition: draft, comment }, feature.kinds);
      }
    });
    if (createdId) setSelected(createdId);
    setError('');
  };

  const remove = () => {
    if (!current || !confirm(`${DB_OBJECT_LABEL[current.kind]} ${current.name}을(를) ERD에서 지울까요? DB에는 "DB로 내보내기"에서 삭제(DROP)를 체크해야 지워집니다.`)) return;
    useStore.getState().edit((d) => removeObject(d, current.id));
    setSelected(objects.find((o) => o.id !== current.id)?.id ?? null);
  };

  return (
    <Modal title="DB 객체 (뷰·함수·프로시저 등)" onClose={onClose} wide>
      <p className="muted small">
        DB의 {feature.kinds.map((k) => DB_OBJECT_LABEL[k]).join('·')}를 CREATE 문(DDL) 그대로 보고 고칩니다. 저장하면 ERD에만 반영되고, DB에는 <b>DB로 내보내기</b>에서 바뀐 것만 반영됩니다.
        DB에 이미 있는 것은 <b>DB에서 가져오기</b>로 가져옵니다.
      </p>
      <div className="objects-layout">
        <aside className="objects-list">
          <input className="objects-search" placeholder="이름·테이블 찾기" value={query} onChange={(e) => setQuery(e.target.value)} />
          {!readOnly && (
            <select className="objects-new" value="" onChange={(e) => e.target.value && startNew(e.target.value as DbObjectKind)}>
              <option value="">+ 새로 만들기…</option>
              {feature.kinds.map((k) => <option key={k} value={k}>{DB_OBJECT_LABEL[k]}</option>)}
            </select>
          )}
          {groups.map((g) => (
            <section key={g.kind}>
              <h5>{DB_OBJECT_LABEL[g.kind]} <span className="muted">{g.items.length}</span></h5>
              <ul>
                {g.items.map((o) => (
                  <li key={o.id}>
                    <button className={`link-btn${o.id === selected ? ' active' : ''}`} onClick={() => setSelected(o.id)} title={o.comment || undefined}>
                      {o.name}
                      {o.table && <span className="muted small"> · {o.table}</span>}
                    </button>
                  </li>
                ))}
                {!g.items.length && <li className="muted small">없음</li>}
              </ul>
            </section>
          ))}
        </aside>
        <div className="objects-editor">
          {!current && !isNew ? (
            <div className="empty-state">{objects.length ? '왼쪽에서 객체를 고르세요' : '아직 DB 객체가 없습니다. DB에서 가져오거나 "+ 새로 만들기"로 만드세요.'}</div>
          ) : (
            <>
              <div className="objects-editor__head">
                <b>{header ? `${DB_OBJECT_LABEL[header.kind]} ${header.name}` : '(CREATE 문이 아님)'}</b>
                {header?.table && <span className="muted small">테이블 {header.table}</span>}
                {isNew && <span className="tag tag-create">새로 만드는 중</span>}
                {!isNew && dirty && <span className="tag tag-alter">저장 안 함</span>}
              </div>
              <textarea
                className="objects-ddl mono"
                spellCheck={false}
                value={draft}
                readOnly={readOnly}
                onChange={(e) => setDraft(e.target.value)}
                aria-label="DDL"
              />
              <input className="objects-comment" placeholder="설명 (ERD에만 저장)" value={comment} readOnly={readOnly} onChange={(e) => setComment(e.target.value)} />
              {error && <div className="error-box">{error}</div>}
              {!readOnly && (
                <div className="btn-row">
                  <button className="btn btn-primary" disabled={!dirty} onClick={save}>{isNew ? '만들기' : '저장'}</button>
                  {!isNew && <button className="btn" disabled={!dirty} onClick={() => { setDraft(current!.definition); setComment(current!.comment ?? ''); setError(''); }}>되돌리기</button>}
                  {isNew && <button className="btn" onClick={() => setSelected(objects[0]?.id ?? null)}>취소</button>}
                  {!isNew && <button className="btn btn-danger" onClick={remove}>삭제</button>}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
