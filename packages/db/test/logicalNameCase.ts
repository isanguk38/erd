// 실제 DB 공통 시나리오: 논리명 없이 만든 테이블을 맞춘 뒤 ERD에서 논리명을 달면
// "ERD에서 바뀜"으로 세고(내보내기 배지), 코멘트로 내보내고, 다시 읽어 비교하면 0건이어야 한다.

import { expect } from 'vitest';
import { applyCommands, emptySchema, generateStatements, planPull, planPush, summarizePlan, syncedBaseline, type Dialect, type Schema } from '@erd/core';
import type { ConnectionConfig, Connector } from '../src';

export async function logicalNameRoundTrip(config: ConnectionConfig, dialect: Dialect, connector: Connector): Promise<void> {
  const schema: Schema = applyCommands(emptySchema(), [
    { op: 'createTable', name: 'tag', columns: [{ name: 'tag_id', type: 'INT', primaryKey: true }, { name: 'label', type: 'VARCHAR(50)', nullable: false }] },
  ]).schema;
  const run = async (erd: Schema, baseline: Schema | null) => {
    const { schema: db } = await connector.introspect(config);
    const plan = planPush(erd, db, { dialect, baseline });
    const statements = generateStatements(plan.diff, dialect, plan.defaultSelected);
    const result = await connector.execute(config, statements.map((s) => s.sql));
    expect(result.results.filter((r) => !r.ok)).toEqual([]);
    return syncedBaseline((await connector.introspect(config)).schema, erd, { previous: baseline });
  };
  const baseline = await run(schema, null);

  const named = structuredClone(schema);
  named.tables[0].logicalName = '태그';
  named.tables[0].columns[1].logicalName = '표시 이름';
  const { schema: db } = await connector.introspect(config);
  // 배지: ERD에서 바뀐 것 2건 (테이블·컬럼 코멘트), DB에서 바뀐 것 없음
  expect(summarizePlan(planPull(named, db, { dialect, baseline }))).toMatchObject({ total: 2, erd: 2, db: 0, conflict: 0 });

  const after = await run(named, baseline);
  const { schema: read } = await connector.introspect(config);
  const tag = read.tables.find((t) => t.name.toLowerCase() === 'tag')!;
  expect(tag.logicalName).toBe('태그');
  expect(tag.columns.find((c) => c.name.toLowerCase() === 'label')?.logicalName).toBe('표시 이름');
  expect(planPush(named, read, { dialect, baseline: after }).diff.changes).toEqual([]);
  expect(planPull(named, read, { dialect, baseline: after }).diff.changes).toEqual([]);
}
