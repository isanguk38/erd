// 영향도 분석: 테이블·컬럼을 지우거나 타입을 바꾸기 전에 무엇이 함께 바뀌는지 알려 준다.
// 스키마는 바꾸지 않는다 (propagateColumnType만 예외 — FK로 이어진 컬럼 타입을 맞춘다).

import { checkName, findTable, indexLabel, indexName, relationName, type Column, type Schema, type Table } from './model';
import { updateColumn } from './operations';
import { sameColumnType } from './lint';

export interface ImpactItem {
  kind: 'relation' | 'index' | 'check' | 'generated' | 'area';
  /** 다른 테이블까지 바뀌면 true (지우기 전에 꼭 확인할 것) */
  external: boolean;
  text: string;
}

/** 식에 이 컬럼 이름이 낱말로 들어 있는지 (따옴표·대괄호로 감싼 것 포함) */
function mentions(expression: string | undefined, name: string): boolean {
  if (!expression?.trim() || !name) return false;
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\w$])[\`"\\[]?${n}[\`"\\]]?(?![\\w$])`, 'i').test(expression);
}

const colNames = (table: Table | undefined, ids: string[]) => ids.map((id) => table?.columns.find((c) => c.id === id)?.name ?? '?').join(', ');

/** 컬럼을 지우면 함께 바뀌는 것 */
export function columnDeleteImpact(schema: Schema, tableId: string, columnId: string): ImpactItem[] {
  const table = findTable(schema, tableId);
  const column = table?.columns.find((c) => c.id === columnId);
  if (!table || !column) return [];
  const items: ImpactItem[] = [];
  for (const r of schema.relations) {
    if (r.toTableId === tableId && r.toColumnIds.includes(columnId) && r.fromTableId !== tableId) {
      const child = findTable(schema, r.fromTableId);
      items.push({ kind: 'relation', external: true, text: `${child?.name}(${colNames(child, r.fromColumnIds)}) → ${table.name}.${column.name} 외래키 ${relationName(schema, r)}가 지워집니다 (${child?.name}의 FK 컬럼은 남음)` });
    } else if (r.fromTableId === tableId && r.fromColumnIds.includes(columnId)) {
      const parent = findTable(schema, r.toTableId);
      items.push({ kind: 'relation', external: false, text: `외래키 ${relationName(schema, r)} (→ ${parent?.name})가 지워집니다` });
    } else if (r.toTableId === tableId && r.toColumnIds.includes(columnId)) {
      items.push({ kind: 'relation', external: false, text: `자기 참조 외래키 ${relationName(schema, r)}가 지워집니다` });
    }
  }
  for (const i of table.indexes) {
    if (i.columnIds.includes(columnId)) {
      const rest = i.columnIds.filter((id) => id !== columnId);
      items.push({
        kind: 'index',
        external: false,
        text: rest.length || i.expression?.trim() ? `인덱스 ${indexName(table, i)}: (${indexLabel(table, i)}) → (${colNames(table, rest)})로 바뀝니다` : `인덱스 ${indexName(table, i)}가 지워집니다`,
      });
    } else if (mentions(i.expression, column.name) || mentions(i.where, column.name)) {
      items.push({ kind: 'index', external: false, text: `인덱스 ${indexName(table, i)}의 식·조건이 이 컬럼을 씁니다 — 고치지 않으면 DB에서 실패합니다` });
    }
  }
  for (const k of table.checks ?? []) {
    if (mentions(k.expression, column.name)) items.push({ kind: 'check', external: false, text: `CHECK ${checkName(table, k)} (${k.expression})가 이 컬럼을 씁니다 — 고치지 않으면 DB에서 실패합니다` });
  }
  for (const c of table.columns) {
    if (c.id !== columnId && mentions(c.generated?.expression, column.name)) items.push({ kind: 'generated', external: false, text: `계산 컬럼 ${c.name} (${c.generated!.expression})가 이 컬럼을 씁니다` });
  }
  return items;
}

/** 테이블을 지우면 함께 바뀌는 것 */
export function tableDeleteImpact(schema: Schema, tableId: string): ImpactItem[] {
  const table = findTable(schema, tableId);
  if (!table) return [];
  const items: ImpactItem[] = [];
  for (const r of schema.relations) {
    if (r.toTableId === tableId && r.fromTableId !== tableId) {
      const child = findTable(schema, r.fromTableId);
      items.push({ kind: 'relation', external: true, text: `${child?.name}(${colNames(child, r.fromColumnIds)}) → ${table.name} 외래키 ${relationName(schema, r)}가 지워집니다 (${child?.name}의 FK 컬럼은 남음)` });
    }
  }
  for (const r of schema.relations) {
    if (r.fromTableId === tableId && r.toTableId !== tableId) {
      items.push({ kind: 'relation', external: false, text: `이 테이블의 외래키 → ${findTable(schema, r.toTableId)?.name}` });
    }
  }
  const areas = (schema.areas ?? []).filter((a) => a.tableIds.includes(tableId));
  if (areas.length) items.push({ kind: 'area', external: false, text: `주제영역 ${areas.map((a) => a.name).join(', ')}에서도 빠집니다` });
  return items;
}

export interface LinkedColumn {
  tableId: string;
  columnId: string;
  table: string;
  column: string;
  type: string;
  length: string;
}

/** 외래키로 이어진 컬럼들 (부모·자식, 그 너머까지). 시작 컬럼은 빼고 */
export function linkedColumns(schema: Schema, tableId: string, columnId: string): LinkedColumn[] {
  const key = (t: string, c: string) => `${t}\u0000${c}`;
  const seen = new Set([key(tableId, columnId)]);
  const queue: [string, string][] = [[tableId, columnId]];
  const out: LinkedColumn[] = [];
  while (queue.length) {
    const [t, c] = queue.shift()!;
    for (const r of schema.relations) {
      const pairs: [string, string][] = [];
      r.fromColumnIds.forEach((fc, i) => {
        const pc = r.toColumnIds[i];
        if (!pc) return;
        if (r.fromTableId === t && fc === c) pairs.push([r.toTableId, pc]);
        if (r.toTableId === t && pc === c) pairs.push([r.fromTableId, fc]);
      });
      for (const [nt, nc] of pairs) {
        if (seen.has(key(nt, nc))) continue;
        seen.add(key(nt, nc));
        const table = findTable(schema, nt);
        const column = table?.columns.find((x) => x.id === nc);
        if (!table || !column) continue;
        out.push({ tableId: nt, columnId: nc, table: table.name, column: column.name, type: column.type, length: column.length });
        queue.push([nt, nc]);
      }
    }
  }
  return out;
}

/** FK로 이어졌는데 타입·길이가 이 컬럼과 다른 컬럼들 */
export function typeMismatches(schema: Schema, tableId: string, columnId: string): LinkedColumn[] {
  const column = findTable(schema, tableId)?.columns.find((c) => c.id === columnId);
  if (!column) return [];
  return linkedColumns(schema, tableId, columnId).filter((l) => !sameColumnType(column, { type: l.type, length: l.length }));
}

/** FK로 이어진 컬럼의 타입·길이를 이 컬럼과 같게 맞춘다. 바꾼 컬럼 이름들 */
export function propagateColumnType(schema: Schema, tableId: string, columnId: string): string[] {
  const column = findTable(schema, tableId)?.columns.find((c) => c.id === columnId);
  if (!column) return [];
  const changed: string[] = [];
  for (const l of typeMismatches(schema, tableId, columnId)) {
    // 자동 증가는 맞추지 않는다 (부모 PK만 자동 증가)
    const type = column.type.replace(/\s+(IDENTITY|SERIAL)$/i, '');
    const patch: Partial<Column> = { type: /^(BIG)?SERIAL$/i.test(type) ? (/^BIG/i.test(type) ? 'BIGINT' : 'INT') : type, length: column.length };
    updateColumn(schema, l.tableId, l.columnId, patch);
    changed.push(`${l.table}.${l.column}`);
  }
  return changed;
}

const fullType = (c: Pick<Column, 'type' | 'length'>) => `${c.type}${c.length ? `(${c.length})` : ''}`;

/**
 * 바꾸기 전·후를 비교해 영향을 글로 (AI 편집 결과에 붙인다).
 * 지운 테이블·컬럼 때문에 함께 사라진 것, 타입을 바꿨는데 FK로 이어진 컬럼은 그대로인 것.
 */
export function changeImpact(before: Schema, after: Schema): string[] {
  const out: string[] = [];
  const afterTables = new Map(after.tables.map((t) => [t.id, t]));
  for (const t of before.tables) {
    const next = afterTables.get(t.id);
    if (!next) {
      for (const i of tableDeleteImpact(before, t.id)) if (i.external) out.push(`${t.name} 삭제: ${i.text}`);
      continue;
    }
    const nextCols = new Map(next.columns.map((c) => [c.id, c]));
    for (const c of t.columns) {
      if (!nextCols.has(c.id)) for (const i of columnDeleteImpact(before, t.id, c.id)) if (i.external || i.kind === 'check' || i.kind === 'generated' || i.text.includes('식·조건')) out.push(`${t.name}.${c.name} 삭제: ${i.text}`);
    }
  }
  for (const t of after.tables) {
    const prev = before.tables.find((x) => x.id === t.id);
    if (!prev) continue;
    for (const c of t.columns) {
      const old = prev.columns.find((x) => x.id === c.id);
      if (!old || sameColumnType(old, c)) continue;
      const off = typeMismatches(after, t.id, c.id);
      if (off.length) out.push(`${t.name}.${c.name} 타입을 ${fullType(old)} → ${fullType(c)}로 바꿨지만 FK로 이어진 ${off.map((l) => `${l.table}.${l.column}(${fullType(l)})`).join(', ')}는 그대로입니다 — updateColumn으로 같이 맞추세요`);
    }
  }
  return [...new Set(out)];
}

/** 여러 테이블을 함께 지울 때 남는 테이블에 생기는 영향 (함께 지우는 테이블끼리의 외래키는 빼고) */
export function tablesDeleteImpact(schema: Schema, tableIds: string[]): ImpactItem[] {
  const ids = new Set(tableIds);
  const items: ImpactItem[] = [];
  for (const r of schema.relations) {
    if (!ids.has(r.toTableId) || ids.has(r.fromTableId)) continue;
    const child = findTable(schema, r.fromTableId);
    const parent = findTable(schema, r.toTableId);
    items.push({ kind: 'relation', external: true, text: `${child?.name}(${colNames(child, r.fromColumnIds)}) → ${parent?.name} 외래키 ${relationName(schema, r)}가 지워집니다 (${child?.name}의 FK 컬럼은 남음)` });
  }
  return items;
}
