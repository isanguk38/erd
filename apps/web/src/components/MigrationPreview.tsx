import { useMemo, useState } from 'react';
import { generateStatements, toScript, type ChangeCategory, type DiffResult, type Dialect } from '@erd/core';
import { downloadText } from '../lib/download';

const GROUPS: { category: ChangeCategory; title: string; hint: string }[] = [
  { category: 'create', title: 'CREATE', hint: '새 테이블과 그 인덱스·외래키' },
  { category: 'alter', title: 'ALTER', hint: '이미 있는 테이블의 수정' },
  { category: 'drop', title: 'DROP', hint: '테이블 삭제' },
];

type SqlTab = 'all' | ChangeCategory;

/**
 * 변경 목록을 CREATE / ALTER / DROP으로 나눠 보여주고, 고른 항목의 SQL을 만든다.
 * SQL 추출과 DB 적용 화면에서 함께 쓴다.
 */
export function MigrationPreview({
  diff,
  dialect,
  selected,
  onSelectedChange,
  fileName,
}: {
  diff: DiffResult;
  dialect: Dialect;
  selected: Set<string>;
  onSelectedChange: (next: Set<string>) => void;
  fileName: string;
}) {
  const [tab, setTab] = useState<SqlTab>('all');
  const [copied, setCopied] = useState(false);
  const statements = useMemo(() => generateStatements(diff, dialect, selected), [diff, dialect, selected]);
  const script = useMemo(() => toScript(statements, { categories: tab === 'all' ? undefined : [tab] }), [statements, tab]);

  const toggle = (ids: string[], on: boolean) => {
    const next = new Set(selected);
    ids.forEach((id) => (on ? next.add(id) : next.delete(id)));
    onSelectedChange(next);
  };

  if (diff.changes.length === 0) {
    return <div className="empty-state">변경 사항이 없습니다. 기준과 지금 ERD가 같습니다.</div>;
  }

  const counts = Object.fromEntries(GROUPS.map((g) => [g.category, statements.filter((s) => s.category === g.category).length])) as Record<ChangeCategory, number>;

  return (
    <div className="migration">
      <div className="migration__changes">
        {GROUPS.map((group) => {
          const changes = diff.changes.filter((c) => c.category === group.category);
          if (changes.length === 0) return null;
          const ids = changes.map((c) => c.id);
          const all = ids.every((id) => selected.has(id));
          return (
            <section key={group.category} className={`change-group change-group--${group.category}`}>
              <label className="change-group__head">
                <input type="checkbox" checked={all} onChange={(e) => toggle(ids, e.target.checked)} />
                <b>{group.title}</b>
                <span className="muted">{group.hint} · {changes.length}건</span>
              </label>
              <ul>
                {changes.map((c) => (
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
      <div className="migration__sql">
        <div className="tabs">
          <button className={tab === 'all' ? 'active' : ''} onClick={() => setTab('all')}>전체 ({statements.length})</button>
          {GROUPS.map((g) => (
            <button key={g.category} className={tab === g.category ? 'active' : ''} disabled={counts[g.category] === 0} onClick={() => setTab(g.category)}>
              {g.title} ({counts[g.category]})
            </button>
          ))}
        </div>
        <pre className="sql-view">{script || '-- 선택한 항목이 없습니다'}</pre>
        <div className="btn-row">
          <button
            className="btn"
            disabled={!script}
            onClick={async () => {
              await navigator.clipboard.writeText(script);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? '복사됨' : '복사'}
          </button>
          <button className="btn btn-primary" disabled={!script} onClick={() => downloadText(script + '\n', `${fileName}${tab === 'all' ? '' : `_${tab}`}.sql`, 'application/sql')}>
            .sql 다운로드
          </button>
        </div>
        {tab === 'all' && <p className="muted small">전체 탭은 의존 관계에 맞는 실행 순서입니다 (외래키 삭제 → … → 테이블 생성 → 컬럼 변경 → 인덱스 → 외래키 추가 → 테이블 삭제).</p>}
      </div>
    </div>
  );
}
