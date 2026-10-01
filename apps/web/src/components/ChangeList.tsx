import type { Change, ChangeCategory } from '@erd/core';

export interface GroupLabel {
  title: string;
  hint: string;
}

export const SQL_GROUPS: Record<ChangeCategory, GroupLabel> = {
  create: { title: 'CREATE', hint: '새 테이블과 그 인덱스·외래키' },
  alter: { title: 'ALTER', hint: '이미 있는 테이블의 수정' },
  drop: { title: 'DROP', hint: '테이블 삭제' },
};

/** 변경 목록을 분류별로 묶어 체크박스로 고르게 한다. SQL 추출, DB 적용/갱신, SQL 가져오기, AI 제안에서 함께 쓴다. */
export function ChangeList({
  changes,
  selected,
  onSelectedChange,
  groups = SQL_GROUPS,
}: {
  changes: Change[];
  selected: Set<string>;
  onSelectedChange: (next: Set<string>) => void;
  groups?: Record<ChangeCategory, GroupLabel>;
}) {
  const toggle = (ids: string[], on: boolean) => {
    const next = new Set(selected);
    ids.forEach((id) => (on ? next.add(id) : next.delete(id)));
    onSelectedChange(next);
  };
  return (
    <div className="migration__changes">
      {(['create', 'alter', 'drop'] as const).map((category) => {
        const items = changes.filter((c) => c.category === category);
        if (items.length === 0) return null;
        const ids = items.map((c) => c.id);
        const all = ids.every((id) => selected.has(id));
        return (
          <section key={category} className={`change-group change-group--${category}`}>
            <label className="change-group__head">
              <input type="checkbox" checked={all} onChange={(e) => toggle(ids, e.target.checked)} />
              <b>{groups[category].title}</b>
              <span className="muted">{groups[category].hint} · {items.length}건</span>
            </label>
            <ul>
              {items.map((c) => (
                <li key={c.id}>
                  <label>
                    <input type="checkbox" checked={selected.has(c.id)} onChange={(e) => toggle([c.id], e.target.checked)} />
                    <span>{c.summary}</span>
                  </label>
                  {c.warning && <div className="warning">⚠ {c.warning}</div>}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
