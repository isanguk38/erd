import type { Schema, Table } from './model';

const HEADER = 34;
const ROW = 22;
const CHAR = 7.2;

/** 화면에 그려질 테이블 크기를 대략 계산한다 (서버/MCP에서도 배치할 수 있도록 DOM 없이). */
export function estimateTableSize(table: Table): { width: number; height: number } {
  const longest = Math.max(
    table.name.length + (table.logicalName.length * 2) + 4,
    ...table.columns.map((c) => c.name.length + c.type.length + c.length.length + 14),
  );
  const width = Math.max(240, Math.round(longest * CHAR) + 40);
  const indexRows = table.indexes.length ? table.indexes.length + 0.6 : 0;
  const height = HEADER + Math.max(1, table.columns.length) * ROW + indexRows * 18 + 10;
  return { width, height };
}

/**
 * 새로 들어온 테이블만 기존 테이블 아래쪽 빈 자리에 격자로 놓는다.
 * 기존 테이블의 위치는 건드리지 않는다.
 */
export function placeNewTables(schema: Schema, tableIds: Iterable<string>): void {
  const ids = new Set(tableIds);
  const existing = schema.tables.filter((t) => !ids.has(t.id));
  const fresh = schema.tables.filter((t) => ids.has(t.id));
  if (!fresh.length) return;
  let top = 0;
  let left = 0;
  if (existing.length) {
    left = Math.min(...existing.map((t) => t.position.x));
    top = Math.max(...existing.map((t) => t.position.y + estimateTableSize(t).height)) + 120;
  }
  const columns = Math.max(3, Math.ceil(Math.sqrt(fresh.length)));
  let x = left;
  let y = top;
  let rowHeight = 0;
  fresh.forEach((table, i) => {
    if (i > 0 && i % columns === 0) {
      x = left;
      y += rowHeight + 60;
      rowHeight = 0;
    }
    const size = estimateTableSize(table);
    table.position = { x, y };
    x += size.width + 60;
    rowHeight = Math.max(rowHeight, size.height);
  });
}
