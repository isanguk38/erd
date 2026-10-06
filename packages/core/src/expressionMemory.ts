// 식 짝 기억: DB는 CHECK 조건·인덱스 식·계산식·기본값을 저장하면서 자기 표기로 바꿔 쓴다
// (PostgreSQL: status IN ('A') → (status)::text = ANY (ARRAY['A'::character varying]), BETWEEN → >= AND <=, ...).
// DB로 내보낸 직후 "ERD에 적힌 식 ↔ DB가 돌려준 식"을 짝으로 기준 시점에 저장해 두고,
// 다음 비교 때 두 쪽이 모두 그대로면 같은 식으로 본다. DB마다 바꿔 쓰는 규칙을 하나씩 만들지 않아도 된다.
// ERD에는 사람이 쓴 식이 그대로 남는다 (읽기 쉽고, 다른 DB로 내보낼 때도 원래 식을 쓴다).

import { normalizeSchema, type Change } from './diff';
import { cloneSchema, type Schema } from './model';

export interface ExpressionPair {
  /** 어떤 식인지 (ERD id 기준). 예: check:tbl_1:chk_2, index:tbl_1:idx_3:where, default:tbl_1:col_4 */
  key: string;
  /** ERD에 적힌 식 */
  erd: string;
  /** 그 식을 DB에 만들었을 때 DB가 돌려준 식 */
  db: string;
}

/** 기준 시점 스키마 (DB에서 읽은 구조를 ERD id로 맞춘 것) + 식 짝 */
export type BaselineSchema = Schema & { expressionPairs?: ExpressionPair[] };

interface Slot {
  get(): string | null | undefined;
  set(value: string): void;
}

/** 스키마 안의 식 자리들 (키 → 읽기/쓰기) */
function slots(schema: Schema): Map<string, Slot> {
  const map = new Map<string, Slot>();
  for (const t of schema.tables) {
    for (const c of t.checks ?? []) map.set(`check:${t.id}:${c.id}`, { get: () => c.expression, set: (v) => void (c.expression = v) });
    for (const i of t.indexes) {
      map.set(`index:${t.id}:${i.id}:expression`, { get: () => i.expression, set: (v) => void (i.expression = v) });
      map.set(`index:${t.id}:${i.id}:where`, { get: () => i.where, set: (v) => void (i.where = v) });
    }
    for (const col of t.columns) {
      map.set(`default:${t.id}:${col.id}`, { get: () => col.defaultValue, set: (v) => void (col.defaultValue = v) });
      map.set(`generated:${t.id}:${col.id}`, {
        get: () => col.generated?.expression,
        set: (v) => void (col.generated && (col.generated.expression = v)),
      });
    }
  }
  return map;
}

const text = (v: string | null | undefined) => (v ?? '').trim();

/** 실행에 성공한 변경이 만든(바꾼) 식 자리 */
function touchedKeys(changes: Change[]): Set<string> {
  const keys = new Set<string>();
  const column = (tableId: string, columnId: string) => {
    keys.add(`default:${tableId}:${columnId}`);
    keys.add(`generated:${tableId}:${columnId}`);
  };
  for (const c of changes) {
    if (c.kind === 'createTable') for (const col of c.table.columns) column(c.table.id, col.id);
    else if (c.kind === 'addColumn') column(c.table.id, c.column.id);
    else if (c.kind === 'alterColumn') column(c.table.id, c.after.id);
    else if (c.kind === 'addCheck') keys.add(`check:${c.table.id}:${c.check.id}`);
    else if (c.kind === 'addIndex') {
      keys.add(`index:${c.table.id}:${c.index.id}:expression`);
      keys.add(`index:${c.table.id}:${c.index.id}:where`);
    }
  }
  return keys;
}

/**
 * 기준 시점을 저장할 때 식 짝을 만든다.
 * - applied: 이번에 DB에 실행해 성공한 변경. 그 변경이 만든 식은 "ERD 식 → DB가 돌려준 식"으로 짝을 짓는다.
 * - previous: 이전 기준 시점의 짝. 이번에 건드리지 않았고 두 쪽이 그대로인 것만 이어받는다.
 * 실행하지 않았거나 실패한 식은 짝을 짓지 않는다 (진짜 차이를 같은 것으로 덮지 않게).
 */
export function rememberExpressions(dbAligned: Schema, erd: Schema, options: { applied?: Change[]; previous?: ExpressionPair[] } = {}): ExpressionPair[] {
  const db = slots(dbAligned);
  const mine = slots(normalizeSchema(erd));
  const touched = touchedKeys(options.applied ?? []);
  const pairs = new Map<string, ExpressionPair>();
  for (const p of options.previous ?? []) {
    if (touched.has(p.key)) continue;
    if (text(mine.get(p.key)?.get()) === p.erd && text(db.get(p.key)?.get()) === p.db) pairs.set(p.key, p);
  }
  for (const key of touched) {
    const erdText = text(mine.get(key)?.get());
    const dbText = text(db.get(key)?.get());
    if (erdText && dbText && erdText !== dbText) pairs.set(key, { key, erd: erdText, db: dbText });
  }
  return [...pairs.values()];
}

/** 기준 시점 스키마에 짝을 붙인다 */
export function withExpressionPairs(dbAligned: Schema, pairs: ExpressionPair[]): BaselineSchema {
  return pairs.length ? { ...dbAligned, expressionPairs: pairs } : dbAligned;
}

/**
 * 비교하기 전에: DB 식이 짝의 DB 모양 그대로이고 ERD 식도 짝의 ERD 모양 그대로면 DB 쪽 식을 ERD 식으로 바꿔 둔다.
 * 어느 한쪽이라도 바뀌었으면 그대로 두어 차이로 나온다 (ERD에서 고침 / 누가 DB를 직접 고침).
 */
export function applyExpressionPairs(dbAligned: Schema, erd: Schema, pairs: ExpressionPair[] | undefined): Schema {
  if (!pairs?.length) return dbAligned;
  const result = cloneSchema(dbAligned);
  const db = slots(result);
  const mine = slots(normalizeSchema(erd));
  for (const p of pairs) {
    const slot = db.get(p.key);
    if (slot && text(slot.get()) === p.db && text(mine.get(p.key)?.get()) === p.erd) slot.set(p.erd);
  }
  return result;
}

/** 실행 결과에서 성공한 변경만 (그 변경의 문장이 모두 성공한 것) */
export function appliedChanges(changes: Change[], statements: { changeId: string }[], results: { ok: boolean }[]): Change[] {
  const ok = new Map<string, boolean>();
  statements.forEach((s, i) => ok.set(s.changeId, (ok.get(s.changeId) ?? true) && Boolean(results[i]?.ok)));
  return changes.filter((c) => ok.get(c.id) === true);
}
