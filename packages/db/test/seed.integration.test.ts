// 테스트 데이터(INSERT)를 실제 서버에 넣어 본다: 외래키·UNIQUE·ENUM·CHECK·자기 참조·다대다·자동 증가가 모두 통과하는지,
// 넣은 뒤 자동 증가가 다음 번호부터 이어지는지. 주소 환경변수(targets.ts)가 있는 DB만 실행한다.

import { afterAll, describe, expect, it } from 'vitest';
import { applyCommands, emptySchema, generateSeedData, generateStatements, getDialect, planPush, type Schema } from '@erd/core';
import { getConnector } from '../src';
import { mariadb, mssql, mysql56Target, mysqlTarget, oracle, postgres } from './targets';

const erd = (): Schema =>
  applyCommands(emptySchema(), [
    { op: 'createEnum', name: 'order_status', values: ['READY', 'PAID', 'CANCEL'] },
    {
      op: 'createTable', name: 'member', logicalName: '회원',
      columns: [
        { name: 'member_id', type: 'BIGINT', primaryKey: true, autoIncrement: true },
        { name: 'member_name', logicalName: '회원명', type: 'VARCHAR(20)', nullable: false },
        { name: 'email', logicalName: '이메일', type: 'VARCHAR(100)', nullable: false, unique: true },
        { name: 'phone', logicalName: '휴대폰번호', type: 'VARCHAR(13)' },
        { name: 'active', type: 'BOOLEAN', nullable: false },
        { name: 'birth_date', type: 'DATE' },
        { name: 'joined_at', type: 'DATETIME', nullable: false },
        { name: 'memo', logicalName: '메모', type: 'TEXT' },
        { name: 'recommender_id', type: 'BIGINT' },
      ],
    },
    { op: 'addRelation', parent: 'member', child: 'member' },
    {
      op: 'createTable', name: 'orders', logicalName: '주문',
      columns: [
        { name: 'order_id', type: 'BIGINT', primaryKey: true, autoIncrement: true },
        { name: 'status', type: 'order_status', nullable: false },
        { name: 'amount', logicalName: '금액', type: 'DECIMAL(12,2)', nullable: false },
        { name: 'qty', type: 'INT', nullable: false },
        { name: 'title', logicalName: '제목', type: 'VARCHAR(10)', nullable: false },
      ],
    },
    { op: 'addRelation', parent: 'member', child: 'orders' },
    { op: 'addCheck', table: 'orders', expression: 'qty BETWEEN 1 AND 5' },
    { op: 'createTable', name: 'tag', columns: [{ name: 'tag_id', type: 'INT', primaryKey: true, autoIncrement: true }, { name: 'tag_name', type: 'VARCHAR(30)', nullable: false, unique: true }] },
    { op: 'createTable', name: 'order_tag', columns: [] },
    { op: 'addRelation', parent: 'orders', child: 'order_tag', identifying: true },
    { op: 'addRelation', parent: 'tag', child: 'order_tag', identifying: true },
  ]).schema;

for (const target of [mysqlTarget, mysql56Target, mariadb, postgres, oracle, mssql]) {
  const dialect = getDialect(target.id);
  const connector = getConnector(target.id);
  describe.skipIf(!target.url)(`테스트 데이터: ${dialect.label}${target === mysql56Target ? ' 5.6' : ''}`, () => {
    afterAll(() => target.cleanup(), 60_000);

    it('만든 INSERT가 모두 들어가고, 자동 증가는 다음 번호부터 이어진다', async () => {
      const config = await target.fresh();
      const schema = erd();
      const created = await connector.execute(config, generateStatements(planPush(schema, emptySchema(), { dialect }).diff, dialect).map((s) => s.sql));
      expect(created.results.filter((r) => !r.ok)).toEqual([]);

      const seed = generateSeedData(schema, dialect, { rows: 30 });
      expect(seed.skipped).toEqual([]);
      const r = await connector.execute(config, seed.statements);
      expect(r.results.filter((x) => !x.ok).map((x) => `${x.error} ← ${x.sql.slice(0, 300)}`)).toEqual([]);

      const q = dialect.quote;
      const count = async (t: string) => Number(Object.values((await target.run(config, `SELECT COUNT(*) AS n FROM ${q(t)}`))[0]!)[0]);
      for (const t of seed.tables) expect(await count(t.name)).toBe(t.rows);
      // 번호를 직접 넣은 뒤에도 자동 증가로 한 행 더 넣을 수 있다
      await target.run(config, `INSERT INTO ${q('tag')} (${q('tag_name')}) VALUES ('after-seed')`);
      expect(await count('tag')).toBe(31);
    }, 120_000);
  });
}
