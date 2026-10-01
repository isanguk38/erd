import type { RenameLink, SyncPlan } from '@erd/core';

/** 3방향 비교의 기준 시점 안내 */
export function BaselineInfo({ plan, baselineAt, direction }: { plan: SyncPlan; baselineAt: string | null; direction: 'pull' | 'push' }) {
  if (!plan.hasBaseline) {
    return (
      <div className="baseline-info none">
        이 DB와 처음 맞추는 거라 <b>누가 바꿨는지(ERD/DB) 구분할 수 없습니다</b>. 이번 {direction === 'pull' ? '가져오기' : '내보내기'} 뒤부터는 구분해서 보여줍니다.
      </div>
    );
  }
  const count = (o: string) => plan.diff.changes.filter((c) => plan.origins[c.id] === o).length;
  return (
    <div className="baseline-info">
      <span>기준: 마지막으로 DB와 맞춘 때 ({baselineAt ? new Date(baselineAt).toLocaleString() : '-'})</span>
      <span className="origin origin-db">DB에서 바뀜 {count('db')}</span>
      <span className="origin origin-erd">ERD에서 바뀜 {count('erd')}</span>
      {count('conflict') > 0 && <span className="origin origin-conflict">둘 다 바뀜 {count('conflict')}</span>}
      <span className="muted small">
        {direction === 'pull'
          ? '기본으로 DB에서 바뀐 것만 고릅니다. ERD에서 바뀐 것은 아직 DB에 안 넣은 설계라 되돌리지 않습니다.'
          : '기본으로 ERD에서 바뀐 것만 고릅니다. DB에서 바뀐 것은 누군가 DB를 직접 고친 것이라 되돌리지 않습니다.'}
      </span>
    </div>
  );
}

/** 이름 변경 후보: 삭제+추가로 보이지만 모양이 같은 것 */
export function RenamePanel({ plan, links, onChange }: { plan: SyncPlan; links: RenameLink[]; onChange: (links: RenameLink[]) => void }) {
  if (!plan.renames.length && !links.length) return null;
  return (
    <div className="rename-panel">
      {plan.renames.map((r) => (
        <div key={r.id} className="rename-row">
          <span className="rename-icon">⚠</span>
          <span>
            {r.kind === 'table' ? '테이블' : `${r.tableName}의 컬럼`} <code>{r.dbName}</code> 삭제 + <code>{r.erdName}</code> 추가로 보입니다.
            <b> 이름 변경인가요?</b> <span className="muted small">(삭제+추가로 실행하면 데이터가 사라집니다)</span>
          </span>
          <button className="btn btn-sm btn-primary" onClick={() => onChange([...links, { kind: r.kind, dbId: r.dbId, erdId: r.erdId }])}>
            이름 변경으로 처리
          </button>
        </div>
      ))}
      {links.length > 0 && (
        <div className="rename-row accepted">
          <span>이름 변경으로 처리한 것 {links.length}건</span>
          <button className="btn btn-sm" onClick={() => onChange([])}>모두 취소</button>
        </div>
      )}
    </div>
  );
}
