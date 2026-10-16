// DB에서 외래키를 직접 고친 뒤 가져오기: 무엇이 바뀌었는지(ON DELETE 변경·추가·삭제)가 "DB에서 바뀜"으로 보이고 기본으로 골라진다.
// 주소 환경변수(targets.ts)가 있는 DB만 실행한다.

import { afterAll, describe, expect, it } from 'vitest';
import { applyCommands, emptySchema, generateStatements, getDialect, planPull, planPush, syncedBaseline, type Schema } from '@erd/core';
import { getConnector } from '../src';
import { mysqlTarget, postgres } from './targets';

for (const target of [postgres, mysqlTarget]) {
  const dialect = getDialect(target.id);
  const c = getConnector(target.id);
  describe.skipIf(!target.url)(`외래키를 DB에서 고친 뒤 가져오기: ${dialect.label}`, () => {
    afterAll(() => target.cleanup(), 60_000);
    it('ON DELETE 변경·새 외래키·외래키 삭제가 DB에서 바뀜으로 보인다', async () => {
      const config = await target.fresh();
      const erd0: Schema = applyCommands(emptySchema(), [
        { op: 'createTable', name: 'member', columns: [{ name: 'member_id', type: 'BIGINT', primaryKey: true }] },
        { op: 'createTable', name: 'coupon', columns: [{ name: 'coupon_id', type: 'BIGINT', primaryKey: true }] },
        { op: 'createTable', name: 'orders', columns: [{ name: 'order_id', type: 'BIGINT', primaryKey: true }, { name: 'coupon_id', type: 'BIGINT' }] },
        { op: 'addRelation', parent: 'member', child: 'orders' },
        { op: 'createTable', name: 'review', columns: [{ name: 'review_id', type: 'BIGINT', primaryKey: true }, { name: 'order_id', type: 'BIGINT' }] },
        { op: 'addRelation', parent: 'orders', child: 'review' },
      ], dialect).schema;
      await c.execute(config, generateStatements(planPush(erd0, emptySchema(), { dialect }).diff, dialect).map((s) => s.sql));
      // ERD = DB에서 가져온 상태, 그때를 기준 시점으로
      const db1 = (await c.introspect(config)).schema;
      const erd = planPull(emptySchema(), db1, { dialect }).dbAligned;
      const baseline = syncedBaseline(db1, erd);
      const q = dialect.quote;
      const fkOf = (table: string) => db1.relations.find((r) => db1.tables.find((t) => t.id === r.fromTableId)!.name === table)!.name;
      const drop = target.id === 'postgresql' ? 'DROP CONSTRAINT' : 'DROP FOREIGN KEY';
      await target.run(config, `ALTER TABLE ${q('orders')} ${drop} ${q(fkOf('orders'))}`);
      await target.run(config, `ALTER TABLE ${q('orders')} ADD CONSTRAINT ${q(fkOf('orders'))} FOREIGN KEY (${q('member_id')}) REFERENCES ${q('member')} (${q('member_id')}) ON DELETE CASCADE`);
      await target.run(config, `ALTER TABLE ${q('orders')} ADD CONSTRAINT fk_orders_coupon FOREIGN KEY (${q('coupon_id')}) REFERENCES ${q('coupon')} (${q('coupon_id')})`);
      await target.run(config, `ALTER TABLE ${q('review')} ${drop} ${q(fkOf('review'))}`);

      const plan = planPull(erd, (await c.introspect(config)).schema, { dialect, baseline });
      const fk = plan.diff.changes.filter((ch) => ch.kind.endsWith('ForeignKey'));
      expect(fk.map((ch) => ch.summary).sort()).toEqual([
        'orders → coupon 외래키 추가',
        'orders → member 외래키 변경 — 기존 외래키 삭제 (ON DELETE NO ACTION → CASCADE)',
        'orders → member 외래키 변경: ON DELETE NO ACTION → CASCADE',
        'review → orders 외래키 삭제',
      ]);
      expect(fk.every((ch) => plan.origins[ch.id] === 'db' && plan.defaultSelected.has(ch.id))).toBe(true);
    }, 60_000);
  });
}
