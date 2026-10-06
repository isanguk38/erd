import { describe, expect, it } from 'vitest';
import { appliedChanges, applyCommands, cloneSchema, diffSchemas, emptySchema, generateStatements, getDialect, planPush, syncedBaseline, type BaselineSchema, type Schema } from '../src';

const dialect = getDialect('postgresql');

/** ERD: 사람이 쓴 식 */
const erdWith = (check: string, where = 'x > 0'): Schema =>
  applyCommands(emptySchema(), [
    { op: 'createTable', name: 't', columns: [{ name: 'id', type: 'BIGINT', primaryKey: true }, { name: 'x', type: 'INTEGER' }] },
    { op: 'addCheck', table: 't', name: 'ck_t_x', expression: check },
    { op: 'addIndex', table: 't', name: 'ix_t_x', columns: ['x'], where },
  ]).schema;

/** DB에서 읽은 구조: DB가 자기 방식으로 바꿔 쓴 식 (어떤 표준화 규칙으로도 같다고 볼 수 없는 모양) */
const dbWith = (check: string, where = 'NOT (x <= 0)'): Schema => erdWith(check, where);

/** 같은 ERD(같은 id)에서 CHECK 식만 바꾼 것 */
const edited = (schema: Schema, check: string): Schema => {
  const next = cloneSchema(schema);
  next.tables[0]!.checks![0]!.expression = check;
  return next;
};

/** ERD를 빈 DB에 내보냈다고 치고, 성공한 변경으로 기준 시점을 만든다 */
function pushed(erd: Schema, db: Schema): BaselineSchema {
  const diff = diffSchemas(emptySchema(), erd, dialect);
  const statements = generateStatements(diff, dialect);
  return syncedBaseline(db, erd, { applied: appliedChanges(diff.changes, statements, statements.map(() => ({ ok: true }))) });
}

describe('식 짝 기억', () => {
  it('짝이 없으면 DB가 바꿔 쓴 식이 차이로 나온다', () => {
    const plan = planPush(erdWith('x > 0'), dbWith('NOT (x <= 0)'), { dialect });
    expect(plan.diff.changes.map((c) => c.kind).sort()).toEqual(['addCheck', 'addIndex', 'dropCheck', 'dropIndex']);
  });

  it('내보낸 직후 짝을 기억하면 다음 비교에서 차이가 없다 (ERD에는 사람이 쓴 식 그대로)', () => {
    const erd = erdWith('x > 0');
    const db = dbWith('NOT (x <= 0)');
    const baseline = pushed(erd, db);
    expect(baseline.expressionPairs?.map((p) => p.erd).sort()).toEqual(['x > 0', 'x > 0']);
    expect(planPush(erd, db, { dialect, baseline }).diff.changes).toEqual([]);
    expect(erd.tables[0]!.checks![0]!.expression).toBe('x > 0');
  });

  it('ERD에서 식을 고치면 내보낼 변경으로 나온다', () => {
    const erd = erdWith('x > 0');
    const baseline = pushed(erd, dbWith('NOT (x <= 0)'));
    const plan = planPush(edited(erd, 'x > 1'), dbWith('NOT (x <= 0)'), { dialect, baseline });
    const check = plan.diff.changes.find((c) => c.kind === 'addCheck');
    expect(check).toBeDefined();
    expect(plan.origins[check!.id]).toBe('erd');
  });

  it('누가 DB에서 직접 고치면 "DB에서 바뀜"으로 나온다', () => {
    const erd = erdWith('x > 0');
    const baseline = pushed(erd, dbWith('NOT (x <= 0)'));
    const plan = planPush(erd, dbWith('NOT (x <= 5)'), { dialect, baseline });
    const check = plan.diff.changes.find((c) => c.kind === 'addCheck');
    expect(check).toBeDefined();
    expect(plan.origins[check!.id]).toBe('db');
  });

  it('실행에 실패한 변경은 짝을 짓지 않는다 (진짜 차이를 덮지 않게)', () => {
    const erd = erdWith('x > 0');
    const diff = diffSchemas(emptySchema(), erd, dialect);
    const statements = generateStatements(diff, dialect);
    const results = statements.map((s) => ({ ok: !s.sql.includes('CHECK') }));
    const baseline = syncedBaseline(dbWith('NOT (x <= 0)'), erd, { applied: appliedChanges(diff.changes, statements, results) });
    expect(baseline.expressionPairs?.map((p) => p.key.split(':')[0])).toEqual(['index']);
  });

  it('다음 동기화(가져오기 등)에서도 두 쪽이 그대로인 짝은 이어받는다', () => {
    const erd = erdWith('x > 0');
    const db = dbWith('NOT (x <= 0)');
    const first = pushed(erd, db);
    const again = syncedBaseline(db, erd, { previous: first });
    expect(again.expressionPairs).toEqual(first.expressionPairs);
    // ERD 식이 바뀌었으면 이어받지 않는다
    expect(syncedBaseline(db, edited(erd, 'x > 1'), { previous: first }).expressionPairs?.some((p) => p.key.startsWith('check'))).toBeFalsy();
  });
});
