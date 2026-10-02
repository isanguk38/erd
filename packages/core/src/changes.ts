// 다른 사람(또는 AI)이 바꾼 곳 찾기: 이전 스키마와 지금 스키마를 비교해 바뀐 테이블·컬럼을 돌려준다.
// 화면에서 잠깐 강조하는 데 쓴다. 위치만 바뀐 것(테이블 옮기기)은 보이므로 넣지 않는다.

import type { Schema, Table } from './model';

export interface ChangedTable {
  /** 새로 생긴 테이블이면 true */
  added: boolean;
  /** 바뀌거나 새로 생긴 컬럼 */
  columnIds: string[];
}

const withoutPosition = (t: Table) => JSON.stringify({ ...t, position: undefined, columns: undefined });

export function changedTables(before: Schema, after: Schema): Map<string, ChangedTable> {
  const result = new Map<string, ChangedTable>();
  const prev = new Map(before.tables.map((t) => [t.id, t]));
  for (const table of after.tables) {
    const old = prev.get(table.id);
    if (!old) {
      result.set(table.id, { added: true, columnIds: table.columns.map((c) => c.id) });
      continue;
    }
    const oldCols = new Map(old.columns.map((c) => [c.id, JSON.stringify(c)]));
    const columnIds = table.columns.filter((c) => oldCols.get(c.id) !== JSON.stringify(c)).map((c) => c.id);
    const removedColumn = old.columns.some((c) => !table.columns.some((x) => x.id === c.id));
    const reordered = !removedColumn && columnIds.length === 0 && old.columns.map((c) => c.id).join() !== table.columns.map((c) => c.id).join();
    if (columnIds.length || removedColumn || reordered || withoutPosition(old) !== withoutPosition(table)) {
      result.set(table.id, { added: false, columnIds });
    }
  }
  // 관계가 생기거나 바뀌면 자식 테이블을 표시한다
  const prevRel = new Map(before.relations.map((r) => [r.id, JSON.stringify(r)]));
  for (const r of after.relations) {
    if (prevRel.get(r.id) !== JSON.stringify(r) && !result.has(r.fromTableId)) result.set(r.fromTableId, { added: false, columnIds: [] });
  }
  return result;
}
