import type { Schema, Table } from './model';

const HEADER = 34;
const ROW = 22;
const CHAR = 7.2;
const GAP = 60;

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

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const boxOf = (t: Table): Box => ({ x: t.position.x, y: t.position.y, w: estimateTableSize(t).width, h: estimateTableSize(t).height });

function overlaps(a: Box, b: Box, margin = 30): boolean {
  return a.x < b.x + b.w + margin && b.x < a.x + a.w + margin && a.y < b.y + b.h + margin && b.y < a.y + a.h + margin;
}

/**
 * 새로 들어온 테이블을 빈 자리에 놓는다. 기존 테이블의 위치는 건드리지 않는다.
 * 관계가 있는 테이블이 있으면 그 옆(오른쪽 → 아래 → 왼쪽 → 위 순)에 놓아 관계선이 짧고 다른 테이블을 덜 가로지르게 한다.
 * 관계가 없으면 기존 테이블 아래쪽에 격자로 놓는다.
 */
export function placeNewTables(schema: Schema, tableIds: Iterable<string>): void {
  const ids = new Set(tableIds);
  const fresh = schema.tables.filter((t) => ids.has(t.id));
  if (!fresh.length) return;
  const placed: Box[] = schema.tables.filter((t) => !ids.has(t.id)).map(boxOf);
  const placedIds = new Set(schema.tables.filter((t) => !ids.has(t.id)).map((t) => t.id));
  const free = (box: Box) => placed.every((p) => !overlaps(box, p));

  // 관계 있는 기존(또는 먼저 놓은) 테이블 찾기: 부모 우선
  const anchorOf = (table: Table): Table | undefined => {
    const parents = schema.relations.filter((r) => r.fromTableId === table.id && r.toTableId !== table.id).map((r) => r.toTableId);
    const children = schema.relations.filter((r) => r.toTableId === table.id && r.fromTableId !== table.id).map((r) => r.fromTableId);
    const id = [...parents, ...children].find((x) => placedIds.has(x));
    return id ? schema.tables.find((t) => t.id === id) : undefined;
  };

  // 관계를 따라 이어지도록, 기존 테이블과 연결된 것부터 놓는다
  const queue = [...fresh];
  const unrelated: Table[] = [];
  let progress = true;
  while (queue.length && progress) {
    progress = false;
    for (let i = 0; i < queue.length; i++) {
      const table = queue[i];
      const anchor = anchorOf(table);
      if (!anchor) continue;
      const { width: w, height: h } = estimateTableSize(table);
      const a = boxOf(anchor);
      const candidates: Box[] = [];
      for (let step = 0; step < 12; step++) {
        const shift = step * (GAP + 40);
        candidates.push(
          { x: a.x + a.w + GAP * 1.5, y: a.y + shift, w, h }, // 오른쪽
          { x: a.x + shift, y: a.y + a.h + GAP, w, h }, // 아래
          { x: a.x - w - GAP * 1.5, y: a.y + shift, w, h }, // 왼쪽
          { x: a.x + shift, y: a.y - h - GAP, w, h }, // 위
        );
      }
      const spot = candidates.find(free);
      if (!spot) continue;
      table.position = { x: Math.round(spot.x), y: Math.round(spot.y) };
      placed.push(spot);
      placedIds.add(table.id);
      queue.splice(i, 1);
      i--;
      progress = true;
    }
  }
  unrelated.push(...queue);
  if (!unrelated.length) return;

  // 관계가 없는 테이블: 기존 테이블 아래쪽 격자
  const left = placed.length ? Math.min(...placed.map((b) => b.x)) : 0;
  let y = placed.length ? Math.max(...placed.map((b) => b.y + b.h)) + 120 : 0;
  const columns = Math.max(3, Math.ceil(Math.sqrt(unrelated.length)));
  let x = left;
  let rowHeight = 0;
  unrelated.forEach((table, i) => {
    if (i > 0 && i % columns === 0) {
      x = left;
      y += rowHeight + GAP;
      rowHeight = 0;
    }
    const size = estimateTableSize(table);
    table.position = { x, y };
    x += size.width + GAP;
    rowHeight = Math.max(rowHeight, size.height);
  });
}
