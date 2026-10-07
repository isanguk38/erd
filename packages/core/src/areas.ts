// 주제영역: 큰 ERD를 "주문", "회원", "정산"처럼 나눠 보는 탭.
// 화면에서 보는 방법일 뿐이라 SQL·DB 동기화·비교(diff)에는 영향이 없다. 같은 테이블이 여러 영역에 들어갈 수 있고,
// 영역마다 테이블 위치를 따로 둔다 (positions에 없으면 전체 ERD 위치).

import { findTable, newId, type Area, type Schema, type Table } from './model';

export const AREA_COLORS = ['#2563eb', '#0891b2', '#059669', '#ca8a04', '#ea580c', '#dc2626', '#9333ea', '#64748b'];

const eq = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export function findArea(schema: Schema, idOrName: string): Area | undefined {
  return schema.areas?.find((a) => a.id === idOrName) ?? schema.areas?.find((a) => eq(a.name, idOrName));
}

export function requireArea(schema: Schema, idOrName: string): Area {
  const area = findArea(schema, idOrName);
  if (!area) throw new Error(`영역 "${idOrName}"이 없습니다. 있는 영역: ${(schema.areas ?? []).map((a) => a.name).join(', ') || '(없음)'}`);
  return area;
}

/** 이 테이블이 들어 있는 영역들 */
export function areasOfTable(schema: Schema, tableId: string): Area[] {
  return (schema.areas ?? []).filter((a) => a.tableIds.includes(tableId));
}

/** 영역 탭에서의 테이블 위치 (영역 위치가 없으면 전체 ERD 위치) */
export function areaPosition(area: Area, table: Table): { x: number; y: number } {
  return area.positions?.[table.id] ?? table.position;
}

function uniqueAreaName(schema: Schema, name: string): string {
  const base = name.trim() || '새 영역';
  const taken = new Set((schema.areas ?? []).map((a) => a.name.trim().toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`;
}

export function createArea(schema: Schema, input: { name: string; color?: string; tableIds?: string[] }): Area {
  const areas = (schema.areas ??= []);
  const area: Area = {
    id: newId('area'),
    name: uniqueAreaName(schema, input.name),
    color: input.color ?? AREA_COLORS[areas.length % AREA_COLORS.length],
    tableIds: [],
  };
  areas.push(area);
  if (input.tableIds?.length) addToArea(schema, area.id, input.tableIds);
  return area;
}

export function updateArea(schema: Schema, areaId: string, patch: { name?: string; color?: string }): Area {
  const area = requireArea(schema, areaId);
  if (patch.name !== undefined && patch.name.trim() && !eq(patch.name, area.name)) area.name = uniqueAreaName(schema, patch.name);
  if (patch.color !== undefined) area.color = patch.color || undefined;
  return area;
}

/** 영역만 지운다 (테이블은 남음) */
export function removeArea(schema: Schema, areaId: string): void {
  const area = requireArea(schema, areaId);
  schema.areas = (schema.areas ?? []).filter((a) => a.id !== area.id);
}

/**
 * 영역에 테이블을 넣는다 (이미 있으면 그대로). 위치를 주지 않으면:
 * - 빈 영역이면 전체 ERD 위치 그대로 (여러 테이블을 한 번에 묶을 때 서로의 배치를 유지)
 * - 이미 테이블이 있는 영역이면 그 아래쪽에 줄지어 놓는다 (멀리 떨어진 전체 ERD 위치 대신)
 */
export function addToArea(schema: Schema, areaId: string, tableIds: string[], positions?: Record<string, { x: number; y: number }>): string[] {
  const area = requireArea(schema, areaId);
  const hadTables = area.tableIds.length > 0;
  const added: string[] = [];
  const toPlace: string[] = [];
  for (const id of tableIds) {
    const table = findTable(schema, id);
    if (!table || area.tableIds.includes(id)) continue;
    area.tableIds.push(id);
    const wanted = positions?.[id];
    if (wanted) area.positions = { ...area.positions, [id]: { x: Math.round(wanted.x), y: Math.round(wanted.y) } };
    else if (hadTables) toPlace.push(id);
    added.push(id);
  }
  if (toPlace.length) placeInArea(schema, area.id, toPlace);
  return added;
}

/** 영역에서 테이블을 뺀다 (테이블은 남음) */
export function removeFromArea(schema: Schema, areaId: string, tableIds: string[]): void {
  const area = requireArea(schema, areaId);
  area.tableIds = area.tableIds.filter((id) => !tableIds.includes(id));
  if (area.positions) for (const id of tableIds) delete area.positions[id];
}

/**
 * 테이블을 다른 영역으로 옮긴다. from을 주면 그 영역에서만 빼고, 안 주면 다른 모든 영역에서 뺀다.
 * 옮긴 영역에서도 원래 영역에서의 위치를 그대로 쓴다 (화면에서 보던 모양 유지).
 */
export function moveToArea(schema: Schema, toAreaId: string, tableIds: string[], fromAreaId?: string): void {
  const to = requireArea(schema, toAreaId);
  const from = fromAreaId ? requireArea(schema, fromAreaId) : undefined;
  // 옮겨 간 영역의 테이블 아래쪽에 놓는다 (원래 영역에서의 위치는 새 영역 배치와 맞지 않음)
  addToArea(schema, to.id, tableIds);
  const sources = from ? [from] : (schema.areas ?? []).filter((a) => a.id !== to.id);
  for (const a of sources) if (a.id !== to.id) removeFromArea(schema, a.id, tableIds);
}

/** 영역 탭에서 테이블을 옮겼을 때 (전체 ERD 위치는 그대로) */
export function setAreaPosition(schema: Schema, areaId: string, tableId: string, position: { x: number; y: number }): void {
  const area = requireArea(schema, areaId);
  area.positions = { ...area.positions, [tableId]: { x: Math.round(position.x), y: Math.round(position.y) } };
}

/**
 * 영역만 떼어 낸 스키마 (영역별 이미지·정의서·AI 검토용).
 * 테이블 위치는 영역 위치로, 관계는 영역 안 테이블끼리만 남긴다. 영역 밖과의 관계는 outside로 알려 준다.
 */
export function areaSchema(schema: Schema, areaId: string): { schema: Schema; outside: { relationId: string; table: string; outsideTable: string }[] } {
  const area = requireArea(schema, areaId);
  const inside = new Set(area.tableIds);
  const tables = schema.tables.filter((t) => inside.has(t.id)).map((t) => ({ ...structuredClone(t), position: areaPosition(area, t) }));
  const relations = schema.relations.filter((r) => inside.has(r.fromTableId) && inside.has(r.toTableId)).map((r) => structuredClone(r));
  const outside = schema.relations
    .filter((r) => inside.has(r.fromTableId) !== inside.has(r.toTableId))
    .map((r) => {
      const [inId, outId] = inside.has(r.fromTableId) ? [r.fromTableId, r.toTableId] : [r.toTableId, r.fromTableId];
      return { relationId: r.id, table: findTable(schema, inId)?.name ?? inId, outsideTable: findTable(schema, outId)?.name ?? outId };
    });
  return { schema: { tables, relations }, outside };
}

/** 어느 영역에도 없는 테이블 */
export function tablesWithoutArea(schema: Schema): Table[] {
  const inAny = new Set((schema.areas ?? []).flatMap((a) => a.tableIds));
  return schema.tables.filter((t) => !inAny.has(t.id));
}

/** 영역에 새로 넣은 테이블을 영역 안 테이블들 아래쪽에 한 줄에 4개씩 놓는다 (전체 ERD에서 멀리 있는 자리 대신) */
export function placeInArea(schema: Schema, areaId: string, tableIds: string[]): void {
  const area = requireArea(schema, areaId);
  const others = area.tableIds.filter((id) => !tableIds.includes(id)).map((id) => findTable(schema, id)).filter(Boolean) as Table[];
  if (!others.length) return;
  const height = (t: Table | undefined) => 60 + 24 * (t?.columns.length ?? 0);
  const points = others.map((t) => ({ p: areaPosition(area, t), h: height(t) }));
  const left = Math.min(...points.map((x) => x.p.x));
  let y = Math.max(...points.map((x) => x.p.y + x.h)) + 80;
  for (let row = 0; row * 4 < tableIds.length; row++) {
    const ids = tableIds.slice(row * 4, row * 4 + 4);
    ids.forEach((id, i) => {
      area.positions = { ...area.positions, [id]: { x: left + i * 300, y } };
    });
    y += Math.max(...ids.map((id) => height(findTable(schema, id)))) + 60;
  }
}

/**
 * 제안(base → target)에서 바뀐 영역을 지금 ERD(current)에 반영한다 (제안을 반영할 때).
 * 영역은 테이블·관계 비교(diff)에 나오지 않으므로 따로 3방향으로 맞춘다: base와 target 사이에 바뀐 것만 current에 옮긴다.
 * 그 사이 다른 사람이 바꾼 영역은 건드리지 않는다. 영역은 id로, 없으면 이름으로 맞춘다.
 */
export function mergeAreaChanges(current: Schema, base: Schema, target: Schema): Schema {
  const next = structuredClone(current);
  const baseAreas = base.areas ?? [];
  const targetAreas = target.areas ?? [];
  const match = (list: Area[] | undefined, a: Area) => list?.find((x) => x.id === a.id) ?? list?.find((x) => eq(x.name, a.name));
  const exists = (id: string) => next.tables.some((t) => t.id === id);

  // 제안에서 지운 영역
  for (const b of baseAreas) {
    if (match(targetAreas, b)) continue;
    const cur = match(next.areas, b);
    if (cur) next.areas = next.areas!.filter((a) => a.id !== cur.id);
  }
  for (const t of targetAreas) {
    const b = match(baseAreas, t);
    let cur = match(next.areas, t);
    if (!cur) {
      if (b) continue; // 제안 전에 있던 영역을 그 사이 누가 지웠으면 그대로 둔다
      cur = { id: t.id, name: t.name, ...(t.color ? { color: t.color } : {}), tableIds: [] };
      (next.areas ??= []).push(cur);
    }
    if (b && b.name !== t.name) cur.name = t.name;
    if (b && b.color !== t.color) cur.color = t.color;
    const before = new Set(b?.tableIds ?? []);
    const after = new Set(t.tableIds);
    for (const id of t.tableIds) {
      if (before.has(id) || !exists(id) || cur.tableIds.includes(id)) continue;
      cur.tableIds.push(id);
      const p = t.positions?.[id];
      if (p) cur.positions = { ...cur.positions, [id]: p };
    }
    for (const id of before) {
      if (after.has(id)) continue;
      cur.tableIds = cur.tableIds.filter((x) => x !== id);
      if (cur.positions) delete cur.positions[id];
    }
  }
  return next;
}
