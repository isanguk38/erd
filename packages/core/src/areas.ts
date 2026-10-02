// 영역(테이블 묶음) 편집. 화면 정리용이라 SQL·비교·DB 동기화에는 쓰지 않는다.

import { newId, type Area, type Schema, type Table } from './model';
import { estimateTableSize } from './placement';

export const AREA_COLORS = ['#2563eb', '#059669', '#d97706', '#db2777', '#7c3aed', '#0891b2', '#64748b'];

/** 테이블 크기 (화면에서 잰 값이 있으면 그것을, 없으면 추정) */
export type SizeOf = (table: Table) => { width: number; height: number };

const PAD = 40;
const HEADER = 36;

function center(table: Table, sizeOf: SizeOf) {
  const { width, height } = sizeOf(table);
  return { x: table.position.x + width / 2, y: table.position.y + height / 2 };
}

function inside(area: Area, p: { x: number; y: number }): boolean {
  return p.x >= area.position.x && p.x <= area.position.x + area.size.width && p.y >= area.position.y && p.y <= area.position.y + area.size.height;
}

/** 테이블들을 감싸는 새 영역. 테이블이 없으면 at 위치에 기본 크기로 만든다. */
export function createArea(schema: Schema, options: { name?: string; tableIds?: string[]; at?: { x: number; y: number }; sizeOf?: SizeOf } = {}): Area {
  const sizeOf = options.sizeOf ?? estimateTableSize;
  const members = schema.tables.filter((t) => options.tableIds?.includes(t.id));
  let position = options.at ?? { x: 0, y: 0 };
  let size = { width: 480, height: 320 };
  if (members.length) {
    const xs = members.flatMap((t) => [t.position.x, t.position.x + sizeOf(t).width]);
    const ys = members.flatMap((t) => [t.position.y, t.position.y + sizeOf(t).height]);
    position = { x: Math.round(Math.min(...xs) - PAD), y: Math.round(Math.min(...ys) - PAD - HEADER) };
    size = { width: Math.round(Math.max(...xs) - Math.min(...xs) + PAD * 2), height: Math.round(Math.max(...ys) - Math.min(...ys) + PAD * 2 + HEADER) };
  }
  const used = new Set((schema.areas ?? []).map((a) => a.color));
  const area: Area = {
    id: newId('area'),
    name: options.name ?? `영역 ${(schema.areas?.length ?? 0) + 1}`,
    color: AREA_COLORS.find((c) => !used.has(c)) ?? AREA_COLORS[(schema.areas?.length ?? 0) % AREA_COLORS.length],
    position,
    size,
    tableIds: members.map((t) => t.id),
  };
  // 다른 영역에 있던 테이블은 새 영역으로 옮긴다 (테이블은 한 영역에만)
  schema.areas = [...(schema.areas ?? []).map((a) => ({ ...a, tableIds: a.tableIds.filter((id) => !area.tableIds.includes(id)) })), area];
  return area;
}

export function updateArea(schema: Schema, areaId: string, patch: Partial<Omit<Area, 'id'>>): void {
  const area = schema.areas?.find((a) => a.id === areaId);
  if (area) Object.assign(area, patch);
}

/** 영역을 지운다. 안의 테이블은 그대로 둔다 (접혀 있었으면 다시 보인다). */
export function removeArea(schema: Schema, areaId: string): void {
  if (schema.areas) schema.areas = schema.areas.filter((a) => a.id !== areaId);
}

/** 영역을 옮긴다. 속한 테이블도 같은 만큼 옮긴다. */
export function moveArea(schema: Schema, areaId: string, to: { x: number; y: number }): void {
  const area = schema.areas?.find((a) => a.id === areaId);
  if (!area) return;
  const dx = Math.round(to.x - area.position.x);
  const dy = Math.round(to.y - area.position.y);
  area.position = { x: area.position.x + dx, y: area.position.y + dy };
  const members = new Set(area.tableIds);
  for (const t of schema.tables) if (members.has(t.id)) t.position = { x: t.position.x + dx, y: t.position.y + dy };
}

/**
 * 테이블이 어느 영역에 속하는지 위치로 다시 정한다 (테이블을 옮기거나 영역 크기를 바꾼 뒤).
 * 접힌 영역의 테이블은 숨겨져 있으므로 그대로 둔다. 여러 영역에 걸치면 가장 작은 영역.
 */
export function assignAreas(schema: Schema, tableIds: string[] | 'all', sizeOf: SizeOf = estimateTableSize): void {
  if (!schema.areas?.length) return;
  const collapsedMembers = new Set(schema.areas.filter((a) => a.collapsed).flatMap((a) => a.tableIds));
  const targets = schema.tables.filter((t) => (tableIds === 'all' || tableIds.includes(t.id)) && !collapsedMembers.has(t.id));
  const open = schema.areas.filter((a) => !a.collapsed).sort((a, b) => a.size.width * a.size.height - b.size.width * b.size.height);
  for (const table of targets) {
    const c = center(table, sizeOf);
    const home = open.find((a) => inside(a, c));
    for (const a of schema.areas) {
      const has = a.tableIds.includes(table.id);
      if (a === home && !has) a.tableIds = [...a.tableIds, table.id];
      else if (a !== home && has && !a.collapsed) a.tableIds = a.tableIds.filter((id) => id !== table.id);
    }
  }
}

/** 지워진 테이블을 영역에서 뺀다 */
export function pruneAreas(schema: Schema): void {
  if (!schema.areas) return;
  const ids = new Set(schema.tables.map((t) => t.id));
  for (const a of schema.areas) if (a.tableIds.some((id) => !ids.has(id))) a.tableIds = a.tableIds.filter((id) => ids.has(id));
}

/** 접힌 영역 때문에 숨겨진 테이블 */
export function hiddenTableIds(schema: Schema): Set<string> {
  return new Set((schema.areas ?? []).filter((a) => a.collapsed).flatMap((a) => a.tableIds));
}

/** 안의 테이블에 맞춰 영역 크기·위치를 다시 잡는다 (자동 정렬 뒤). 빈 영역과 접힌 영역은 그대로 */
export function fitAreasToTables(schema: Schema, sizeOf: SizeOf = estimateTableSize): void {
  for (const area of schema.areas ?? []) {
    if (area.collapsed) continue;
    const members = schema.tables.filter((t) => area.tableIds.includes(t.id));
    if (!members.length) continue;
    const xs = members.flatMap((t) => [t.position.x, t.position.x + sizeOf(t).width]);
    const ys = members.flatMap((t) => [t.position.y, t.position.y + sizeOf(t).height]);
    area.position = { x: Math.round(Math.min(...xs) - PAD), y: Math.round(Math.min(...ys) - PAD - HEADER) };
    area.size = { width: Math.round(Math.max(...xs) - Math.min(...xs) + PAD * 2), height: Math.round(Math.max(...ys) - Math.min(...ys) + PAD * 2 + HEADER) };
  }
}
