import { useMemo } from 'react';
import { useReactFlow } from '@xyflow/react';
import { diffSchemas, getDialect, type Change, type DialectId } from '@erd/core';
import { useStore } from '../store';

const CATEGORY = { create: '생성', alter: '수정', drop: '삭제' } as const;

function useCompareChanges(): Change[] {
  const compare = useStore((s) => s.compare);
  const schema = useStore((s) => s.schema);
  const dialect = useStore((s) => s.meta.dialect);
  return useMemo(
    () => (compare ? diffSchemas(compare.schema, schema, getDialect((dialect || 'mysql') as DialectId)).changes : []),
    [compare, schema, dialect],
  );
}

/** 버전 비교 중 캔버스 위 안내 */
export function CompareBanner() {
  const compare = useStore((s) => s.compare);
  const changes = useCompareChanges();
  if (!compare) return null;
  const added = changes.filter((c) => c.kind === 'createTable').length;
  const removed = changes.filter((c) => c.kind === 'dropTable').length;
  return (
    <div className="compare-banner">
      <b>버전 비교</b>
      <span>"{compare.name}" → 지금 ERD</span>
      <span className="compare-count" style={{ color: 'var(--create)' }}>테이블 +{added}</span>
      <span className="compare-count" style={{ color: 'var(--drop)' }}>테이블 −{removed}</span>
      <span className="compare-count">변경 {changes.length}건</span>
      <button className="btn btn-sm btn-primary" onClick={() => useStore.getState().setCompare(null)}>비교 끝내기</button>
    </div>
  );
}

function tableIdOf(c: Change): string | undefined {
  switch (c.kind) {
    case 'renameTable':
    case 'primaryKey':
      return c.after.id;
    case 'addForeignKey':
    case 'dropForeignKey':
      return c.relation.fromTableId;
    default:
      return c.table.id;
  }
}

/** 비교 중 오른쪽 패널: 변경 목록 (누르면 그 테이블로 이동) */
export function ComparePanel() {
  const compare = useStore((s) => s.compare)!;
  const changes = useCompareChanges();
  const { fitView } = useReactFlow();

  return (
    <aside className="inspector">
      <div className="inspector__head">
        <h3>바뀐 점 {changes.length}건</h3>
      </div>
      <p className="muted small">
        "{compare.name}" ({new Date(compare.createdAt).toLocaleString()}) 이후 바뀐 것입니다. 초록은 추가, 노랑은 변경, 빨강은 삭제입니다. 비교하는 동안에는 편집할 수 없습니다.
      </p>
      {changes.length === 0 && <div className="empty-state">바뀐 것이 없습니다.</div>}
      <ul className="compare-list">
        {changes.map((c) => (
          <li key={c.id}>
            <button
              onClick={() => {
                const id = tableIdOf(c);
                if (id) fitView({ nodes: [{ id }], padding: 0.6, duration: 300, maxZoom: 1.2 });
              }}
            >
              <span className={`tag tag-${c.category}`}>{CATEGORY[c.category]}</span>
              <span>{c.summary}</span>
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
