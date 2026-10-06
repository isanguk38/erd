// ERD ↔ DB 동기화 계획.
//
// 1) 3방향 비교: "마지막으로 DB와 맞춘 시점(baseline)"을 기준으로 각 차이를 누가 만들었는지 나눈다.
//    - db:       DB만 바뀜 (누군가 DB를 직접 고침) → 가져오기 대상
//    - erd:      ERD만 바뀜 (아직 DB에 적용 안 한 설계) → 내보내기 대상
//    - conflict: 둘 다 바뀜 → 사람이 판단
//    - unknown:  기준 시점이 없어 알 수 없음
//    가져오기는 erd 변경을 되돌리지 않고, 내보내기는 db 변경을 되돌리지 않도록 기본 선택을 정한다.
//
// 2) 이름 변경 추정: DB에는 rename 기록이 없어서 컬럼·테이블 이름을 바꾸면 "삭제 + 추가"로 보인다.
//    그대로 실행하면 데이터가 사라지므로, 모양이 같은 삭제+추가 쌍을 "이름 변경 후보"로 알려준다.
//    사람이 받아들이면 두 요소를 같은 것으로 묶어(link) RENAME으로 처리한다.

import { diffSchemas, type Change, type DiffResult } from './diff';
import { applyExpressionPairs, rememberExpressions, withExpressionPairs, type BaselineSchema } from './expressionMemory';
import type { Dialect } from './dialects/types';
import { cloneSchema, type Column, type Schema, type Table } from './model';
import { alignToCurrent } from './sync';

export type ChangeOrigin = 'db' | 'erd' | 'conflict' | 'unknown';

export interface RenameSuggestion {
  /** 받아들일 때 쓰는 id */
  id: string;
  kind: 'column' | 'table';
  tableName: string;
  /** DB 쪽 이름 / ERD 쪽 이름 */
  dbName: string;
  erdName: string;
  /** DB 쪽 요소 id → ERD 쪽 요소 id로 묶는다 */
  dbId: string;
  erdId: string;
  /** 묶으면 사라질 삭제·추가 변경 */
  replaces: string[];
}

/** 이름 변경으로 확정한 묶음: DB 쪽 요소를 ERD 쪽 id로 본다 */
export interface RenameLink {
  kind: 'column' | 'table';
  dbId: string;
  erdId: string;
}

export interface SyncPlan {
  direction: 'pull' | 'push';
  /** pull: ERD → DB 모양으로 가는 변경, push: DB → ERD 모양으로 가는 변경 */
  diff: DiffResult;
  origins: Record<string, ChangeOrigin>;
  renames: RenameSuggestion[];
  /** 처음에 체크해 둘 변경 */
  defaultSelected: Set<string>;
  hasBaseline: boolean;
  /** ERD id로 맞춘 DB 스키마 (기준 시점 저장 등에 쓴다) */
  dbAligned: Schema;
}

export interface PlanOptions {
  dialect: Dialect;
  /** 마지막으로 DB와 맞춘 시점의 스키마 (ERD id 기준) */
  baseline?: Schema | null;
  /** 이름 변경으로 확정한 것 */
  links?: RenameLink[];
}

/** 변경이 가리키는 요소. 같은 요소에 대한 변경인지 비교할 때 쓴다. */
export function changeKey(change: Change): string {
  switch (change.kind) {
    case 'createTable':
    case 'dropTable':
      return `t:${change.table.id}`;
    case 'renameTable':
      return `t:${change.after.id}:name`;
    case 'tableComment':
      return `t:${change.table.id}:comment`;
    case 'addColumn':
    case 'dropColumn':
      return `c:${change.column.id}`;
    case 'alterColumn':
      return `c:${change.after.id}`;
    case 'primaryKey':
      return `pk:${change.after.id}`;
    case 'addIndex':
    case 'dropIndex':
      return `i:${change.index.id}`;
    case 'addForeignKey':
    case 'dropForeignKey':
      return `r:${change.relation.id}`;
    case 'addCheck':
    case 'dropCheck':
      return `k:${change.check.id}`;
  }
}

/** DB 스키마의 요소 id를 바꾼다 (참조하는 인덱스·관계까지) */
function relink(schema: Schema, link: RenameLink): void {
  if (link.kind === 'table') {
    for (const t of schema.tables) if (t.id === link.dbId) t.id = link.erdId;
    for (const r of schema.relations) {
      if (r.fromTableId === link.dbId) r.fromTableId = link.erdId;
      if (r.toTableId === link.dbId) r.toTableId = link.erdId;
    }
    return;
  }
  for (const t of schema.tables) {
    for (const c of t.columns) if (c.id === link.dbId) c.id = link.erdId;
    for (const i of t.indexes) i.columnIds = i.columnIds.map((id) => (id === link.dbId ? link.erdId : id));
  }
  for (const r of schema.relations) {
    r.fromColumnIds = r.fromColumnIds.map((id) => (id === link.dbId ? link.erdId : id));
    r.toColumnIds = r.toColumnIds.map((id) => (id === link.dbId ? link.erdId : id));
  }
}

/** DB 스키마를 ERD id로 맞춘다 (이름 기준 + 기준 시점 + 확정한 이름 변경) */
export function alignDb(db: Schema, erd: Schema, baseline?: Schema | null, links: RenameLink[] = []): Schema {
  let aligned = alignToCurrent(db, erd);
  // 지금 ERD에서 이름을 바꾼 요소는 기준 시점 이름으로 찾는다 (기준 시점도 ERD id로 맞춘 뒤)
  if (baseline) aligned = alignToCurrent(aligned, alignToCurrent(baseline, erd));
  aligned = cloneSchema(aligned);

  // 테이블 묶음: DB 테이블을 잠시 ERD 이름으로 바꿔 이름 맞추기를 다시 하면 그 안의 컬럼·인덱스까지 맞는다
  const tableLinks = links.filter((l) => l.kind === 'table');
  if (tableLinks.length) {
    const original = new Map<string, string>();
    for (const link of tableLinks) {
      const dbTable = aligned.tables.find((t) => t.id === link.dbId);
      const erdTable = erd.tables.find((t) => t.id === link.erdId);
      if (!dbTable || !erdTable) continue;
      original.set(link.erdId, dbTable.name);
      dbTable.name = erdTable.name;
    }
    aligned = alignToCurrent(aligned, erd);
    for (const t of aligned.tables) if (original.has(t.id)) t.name = original.get(t.id)!;
  }

  // 컬럼 묶음: id를 ERD 컬럼으로 바꾸고, DB에 코멘트가 없으면 ERD의 논리명·설명을 이어받는다
  for (const link of links.filter((l) => l.kind === 'column')) {
    relink(aligned, link);
    const erdColumn = erd.tables.flatMap((t) => t.columns).find((c) => c.id === link.erdId);
    const dbColumn = aligned.tables.flatMap((t) => t.columns).find((c) => c.id === link.erdId);
    if (erdColumn && dbColumn && !dbColumn.logicalName && !dbColumn.comment) {
      dbColumn.logicalName = erdColumn.logicalName;
      dbColumn.comment = erdColumn.comment;
    }
  }
  // DB가 바꿔 쓴 식은 내보낼 때 기억한 짝으로 ERD 식과 맞춘다 (expressionMemory.ts)
  return applyExpressionPairs(aligned, erd, (baseline as BaselineSchema | null | undefined)?.expressionPairs);
}

function sameShape(dialect: Dialect, a: Column, b: Column): boolean {
  return (
    dialect.renderType(a) === dialect.renderType(b) &&
    (a.nullable && !a.primaryKey && !a.autoIncrement) === (b.nullable && !b.primaryKey && !b.autoIncrement) &&
    dialect.normalizeDefault(a.defaultValue) === dialect.normalizeDefault(b.defaultValue) &&
    a.autoIncrement === b.autoIncrement &&
    a.primaryKey === b.primaryKey
  );
}

/**
 * 삭제+추가 쌍 중 모양이 같은 것을 이름 변경 후보로 찾는다.
 * dbSide: diff에서 DB 쪽 스키마가 base인지(push) target인지(pull)
 */
export function findRenameSuggestions(diff: DiffResult, dialect: Dialect, dbSide: 'base' | 'target'): RenameSuggestion[] {
  const suggestions: RenameSuggestion[] = [];
  // push: DB(base)에만 있음 = drop, ERD(target)에만 있음 = add
  // pull: ERD(base)에만 있음 = drop, DB(target)에만 있음 = add
  const dbOnly = dbSide === 'base' ? 'drop' : 'add';

  // 컬럼
  const byTable = new Map<string, { drops: Extract<Change, { kind: 'dropColumn' }>[]; adds: Extract<Change, { kind: 'addColumn' }>[] }>();
  for (const c of diff.changes) {
    if (c.kind !== 'dropColumn' && c.kind !== 'addColumn') continue;
    const entry = byTable.get(c.table.id) ?? { drops: [], adds: [] };
    if (c.kind === 'dropColumn') entry.drops.push(c);
    else entry.adds.push(c);
    byTable.set(c.table.id, entry);
  }
  for (const [, { drops, adds }] of byTable) {
    const usedAdds = new Set<string>();
    for (const drop of drops) {
      const candidates = adds.filter((a) => !usedAdds.has(a.id) && sameShape(dialect, drop.column, a.column));
      // 같은 모양이 여럿이면 같은 자리(앞 컬럼 기준)에 가까운 것을 고른다
      const dropTable = diff.base.tables.find((t) => t.id === drop.table.id);
      const dropIndex = dropTable ? dropTable.columns.findIndex((c) => c.id === drop.column.id) : -1;
      const pick = candidates.sort((x, y) => Math.abs(indexOf(diff.target, x) - dropIndex) - Math.abs(indexOf(diff.target, y) - dropIndex))[0];
      if (!pick) continue;
      usedAdds.add(pick.id);
      const [db, erd] = dbOnly === 'drop' ? [drop.column, pick.column] : [pick.column, drop.column];
      suggestions.push({
        id: `rename:c:${db.id}:${erd.id}`,
        kind: 'column',
        tableName: pick.table.name,
        dbName: db.name,
        erdName: erd.name,
        dbId: db.id,
        erdId: erd.id,
        replaces: [drop.id, pick.id],
      });
    }
  }

  // 테이블: 컬럼 이름 구성이 같으면 이름 변경 후보
  const drops = diff.changes.filter((c): c is Extract<Change, { kind: 'dropTable' }> => c.kind === 'dropTable');
  const creates = diff.changes.filter((c): c is Extract<Change, { kind: 'createTable' }> => c.kind === 'createTable');
  const signature = (t: Table) => t.columns.map((c) => `${c.name.toLowerCase()}:${dialect.renderType(c)}`).sort().join('|');
  const usedCreates = new Set<string>();
  for (const drop of drops) {
    const sig = signature(drop.table);
    const pick = creates.find((c) => !usedCreates.has(c.id) && signature(c.table) === sig && drop.table.columns.length > 0);
    if (!pick) continue;
    usedCreates.add(pick.id);
    const [db, erd] = dbOnly === 'drop' ? [drop.table, pick.table] : [pick.table, drop.table];
    const related = diff.changes
      .filter((c) => (c.kind === 'addIndex' || c.kind === 'addForeignKey' || c.kind === 'dropForeignKey') && (c.tableName === drop.table.name || c.tableName === pick.table.name))
      .map((c) => c.id);
    suggestions.push({
      id: `rename:t:${db.id}:${erd.id}`,
      kind: 'table',
      tableName: erd.name,
      dbName: db.name,
      erdName: erd.name,
      dbId: db.id,
      erdId: erd.id,
      replaces: [drop.id, pick.id, ...related],
    });
  }
  return suggestions;
}

function indexOf(schema: Schema, change: Extract<Change, { kind: 'addColumn' }>): number {
  const table = schema.tables.find((t) => t.id === change.table.id);
  return table ? table.columns.findIndex((c) => c.id === change.column.id) : 0;
}

/** 요소별로 무엇이 바뀌었는지 (기준 → 어떤 스키마) */
function changedKeys(from: Schema, to: Schema, dialect: Dialect): Set<string> {
  return new Set(diffSchemas(from, to, dialect).changes.map(changeKey));
}

function classify(diff: DiffResult, erd: Schema, dbAligned: Schema, baseline: Schema | null | undefined, dialect: Dialect) {
  const origins: Record<string, ChangeOrigin> = {};
  if (!baseline) {
    for (const c of diff.changes) origins[c.id] = 'unknown';
    return origins;
  }
  // 기준 시점 스키마도 이름으로 ERD id에 맞춘다 (id가 어긋나 있어도 비교가 깨지지 않게)
  // 기준 시점의 식도 짝으로 ERD 식에 맞춘다 (그래야 DB가 바꿔 쓴 식을 "ERD에서 바뀜"으로 오해하지 않는다)
  const base = applyExpressionPairs(alignToCurrent(baseline, erd), erd, (baseline as BaselineSchema).expressionPairs);
  const byErd = changedKeys(base, erd, dialect);
  const byDb = changedKeys(base, dbAligned, dialect);
  for (const c of diff.changes) {
    const key = changeKey(c);
    const erdChanged = byErd.has(key);
    const dbChanged = byDb.has(key);
    origins[c.id] = erdChanged && dbChanged ? 'conflict' : erdChanged ? 'erd' : dbChanged ? 'db' : 'unknown';
  }
  return origins;
}

/**
 * DB → ERD (가져오기) 계획.
 * 기본 선택: DB에서 바뀐 것. ERD에서만 바뀐 것(아직 DB에 안 넣은 설계)은 되돌리지 않도록 빼 둔다.
 */
export function planPull(erd: Schema, db: Schema, options: PlanOptions): SyncPlan {
  const { dialect, baseline, links = [] } = options;
  const dbAligned = alignDb(db, erd, baseline, links);
  const diff = diffSchemas(erd, dbAligned, dialect);
  const origins = classify(diff, erd, dbAligned, baseline, dialect);
  const defaultSelected = new Set(
    diff.changes
      .filter((c) => {
        const o = origins[c.id];
        if (o === 'erd' || o === 'conflict') return false;
        // ERD 테이블 삭제는 DB에서 지운 게 확실할 때만 미리 체크
        if (c.category === 'drop') return o === 'db';
        return true;
      })
      .map((c) => c.id),
  );
  return { direction: 'pull', diff, origins, renames: findRenameSuggestions(diff, dialect, 'target'), defaultSelected, hasBaseline: Boolean(baseline), dbAligned };
}

/**
 * ERD → DB (내보내기) 계획.
 * 기본 선택: ERD에서 바뀐 것. DB에서만 바뀐 것(누군가 DB를 직접 고친 것)은 되돌리지 않도록 빼 둔다.
 * 테이블 삭제(DROP)는 항상 직접 골라야 한다.
 */
export function planPush(erd: Schema, db: Schema, options: PlanOptions): SyncPlan {
  const { dialect, baseline, links = [] } = options;
  const dbAligned = alignDb(db, erd, baseline, links);
  const diff = diffSchemas(dbAligned, erd, dialect);
  const origins = classify(diff, erd, dbAligned, baseline, dialect);
  const defaultSelected = new Set(
    diff.changes.filter((c) => c.category !== 'drop' && origins[c.id] !== 'db' && origins[c.id] !== 'conflict').map((c) => c.id),
  );
  return { direction: 'push', diff, origins, renames: findRenameSuggestions(diff, dialect, 'base'), defaultSelected, hasBaseline: Boolean(baseline), dbAligned };
}

/** 이름 변경 후보를 확정 링크로 바꾼다 */
export function toLink(s: RenameSuggestion): RenameLink {
  return { kind: s.kind, dbId: s.dbId, erdId: s.erdId };
}

export const ORIGIN_LABEL: Record<ChangeOrigin, string> = {
  db: 'DB에서 바뀜',
  erd: 'ERD에서 바뀜',
  conflict: '둘 다 바뀜',
  unknown: '',
};

/** 비교 결과 요약 (배지·MCP용) */
export function summarizePlan(plan: SyncPlan) {
  const count = (o: ChangeOrigin) => plan.diff.changes.filter((c) => plan.origins[c.id] === o).length;
  return { total: plan.diff.changes.length, db: count('db'), erd: count('erd'), conflict: count('conflict'), unknown: count('unknown'), renames: plan.renames.length };
}

/**
 * DB와 맞춘 뒤 저장할 기준 시점: 지금 DB 구조(ERD id로 맞춤) + 식 짝.
 * applied: 이번에 DB에 실행해 성공한 변경 (내보내기). previous: 이전 기준 시점 (이어받을 짝).
 */
export function syncedBaseline(
  db: Schema,
  erd: Schema,
  options: { links?: RenameLink[]; applied?: Change[]; previous?: Schema | null } = {},
): BaselineSchema {
  const aligned = alignDb(db, erd, null, options.links ?? []);
  const previous = (options.previous as BaselineSchema | null | undefined)?.expressionPairs;
  return withExpressionPairs(aligned, rememberExpressions(aligned, erd, { applied: options.applied, previous }));
}
