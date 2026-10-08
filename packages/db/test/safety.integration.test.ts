// DB 반영 전 안전 검사를 실제 서버로: 데이터를 넣고, 실패할 변경을 정확히 세는지 + 검사 뒤 DB가 그대로인지.
// 주소 환경변수(targets.ts)가 있는 DB만 실행한다.

import { afterAll, describe, expect, it } from 'vitest';
import {
  addIndex,
  applyCommands,
  cloneSchema,
  createCheck,
  createRelation,
  emptySchema,
  generateStatements,
  getDialect,
  planPush,
  removeColumn,
  safetyChecks,
  safetyFindings,
  updateColumn,
  type Schema,
} from '@erd/core';
import { getConnector } from '../src';
import { mariadb, mssql, mysql56Target, mysqlTarget, oracle, postgres } from './targets';

const base = (): Schema =>
  applyCommands(emptySchema(), [
    { op: 'createTable', name: 'member', columns: [
      { name: 'member_id', type: 'BIGINT', primaryKey: true },
      { name: 'email', type: 'VARCHAR(100)' },
      { name: 'code', type: 'VARCHAR(20)' },
      { name: 'nick', type: 'VARCHAR(50)' },
      { name: 'qty_text', type: 'VARCHAR(20)' },
    ] },
    { op: 'createTable', name: 'orders', columns: [
      { name: 'order_id', type: 'BIGINT', primaryKey: true },
      { name: 'buyer_id', type: 'BIGINT' },
      { name: 'amount', type: 'DECIMAL(12,2)' },
    ] },
  ]).schema;

const ROWS = [
  "INSERT INTO member (member_id, email, code, nick, qty_text) VALUES (1, 'a@x.com', 'A', 'a-very-long-nickname', '12')",
  "INSERT INTO member (member_id, email, code, nick, qty_text) VALUES (2, 'a@x.com', 'B', NULL, 'abc')",
  "INSERT INTO member (member_id, email, code, nick, qty_text) VALUES (3, NULL, 'C', 'n', ' 7 ')",
  'INSERT INTO orders (order_id, buyer_id, amount) VALUES (10, 1, 5)',
  'INSERT INTO orders (order_id, buyer_id, amount) VALUES (11, 99, -1)',
  'INSERT INTO orders (order_id, buyer_id, amount) VALUES (12, NULL, 3)',
];

for (const target of [mysqlTarget, mysql56Target, mariadb, postgres, oracle, mssql]) {
  const dialect = getDialect(target.id);
  const connector = getConnector(target.id);
  describe.skipIf(!target.url)(`안전 검사: ${dialect.label}${target === mysql56Target ? ' 5.6' : ''}`, () => {
    afterAll(() => target.cleanup(), 60_000);

    it('실패할 변경과 사라질 데이터를 센다 (검사 뒤 DB는 그대로)', async () => {
      const config = await target.fresh();
      // 처음 구조를 만들고 데이터를 넣는다
      const created = await connector.execute(config, generateStatements(planPush(base(), emptySchema(), { dialect }).diff, dialect).map((s) => s.sql));
      expect(created.results.filter((r) => !r.ok)).toEqual([]);
      for (const row of ROWS) await target.run(config, row);

      // DB를 읽은 구조에서 ERD를 고친다 (id가 같아야 같은 테이블·컬럼으로 맞는다)
      const db = (await connector.introspect(config)).schema;
      const erd = cloneSchema(db);
      const member = erd.tables.find((t) => t.name === 'member')!;
      const orders = erd.tables.find((t) => t.name === 'orders')!;
      const col = (t: typeof member, n: string) => t.columns.find((c) => c.name === n)!;
      addIndex(erd, member.id, { columnIds: [col(member, 'email').id], unique: true, name: 'ux_member_email' });
      updateColumn(erd, member.id, col(member, 'email').id, { nullable: false });
      updateColumn(erd, member.id, col(member, 'nick').id, { length: '5' });
      updateColumn(erd, member.id, col(member, 'qty_text').id, { type: 'INT', length: '' });
      removeColumn(erd, member.id, col(member, 'code').id);
      erd.relations.push(createRelation({ fromTableId: orders.id, fromColumnIds: [col(orders, 'buyer_id').id], toTableId: member.id, toColumnIds: [col(member, 'member_id').id] }));
      orders.checks = [createCheck({ expression: 'amount >= 0' })];
      orders.columns.push({ ...col(orders, 'buyer_id'), id: 'col_status', name: 'status', type: 'VARCHAR', length: '10', nullable: false });

      const plan = planPush(erd, db, { dialect });
      const changes = plan.diff.changes;
      const checks = safetyChecks(changes, plan.dbAligned);
      const results = await connector.check(config, checks);
      expect(results.filter((r) => r.count === null)).toEqual([]);
      const count = (kind: string) => results.find((r) => checks.find((c) => c.id === r.id)?.kind === kind)?.count;
      expect({
        duplicates: count('duplicates'),
        nulls: count('nulls'),
        tooLong: count('tooLong'),
        notNumeric: count('notNumeric'),
        values: count('values'),
        orphans: count('orphans'),
        check: count('check'),
        rows: count('rows'),
      }).toEqual({ duplicates: 1, nulls: 1, tooLong: 1, notNumeric: 1, values: 3, orphans: 1, check: 1, rows: 3 });
      const findings = safetyFindings(checks, results);
      expect([...findings.values()].flat().filter((f) => f.level === 'fail')).toHaveLength(7);
      expect([...findings.values()].flat().filter((f) => f.level === 'loss')).toHaveLength(1);

      // 검사는 읽기만 했다
      const after = (await connector.introspect(config)).schema;
      expect(after.tables.find((t) => t.name === 'member')!.columns.map((c) => c.name)).toEqual(['member_id', 'email', 'code', 'nick', 'qty_text']);
      expect(after.relations).toEqual([]);
    }, 120000);
  });
}
