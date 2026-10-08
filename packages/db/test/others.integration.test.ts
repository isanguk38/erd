// MariaDB·Oracle·SQL Server 실제 서버로 하는 왕복 테스트 (CI에서 컨테이너로 실행).
// 주소를 주면 실행하고, 없으면 건너뛴다:
//   ERD_TEST_MARIADB=mysql://root:pw@127.0.0.1:3307
//   ERD_TEST_ORACLE=oracle://system:pw@127.0.0.1:1521/FREEPDB1
//   ERD_TEST_MSSQL=mssql://sa:Passw0rd!@127.0.0.1:1433
// 테스트마다 임시 DB(Oracle은 임시 사용자)를 만들고 끝나면 지운다.

import { afterAll, describe, expect, it } from 'vitest';
import { addColumn, addIndex, applyCommands, cloneSchema, emptySchema, generateStatements, getDialect, planPush, toLink, type DialectId, type Schema } from '@erd/core';
import { getConnector, type ConnectionConfig } from '../src';
import { mariadb, mssql, oracle } from './targets';
import { typeRuleMismatches } from './typeCases';
import { logicalNameRoundTrip } from './logicalNameCase';

function erd(): Schema {
  return applyCommands(emptySchema(), [
    {
      op: 'createTable', name: 'member', logicalName: '회원',
      columns: [
        { name: 'member_id', logicalName: '회원번호', type: 'BIGINT', primaryKey: true, autoIncrement: true },
        { name: 'email', logicalName: '이메일', type: 'VARCHAR(100)', nullable: false, unique: true },
        { name: 'is_active', logicalName: '사용여부', type: 'BOOLEAN', nullable: false, default: '1' },
        { name: 'grade', type: 'VARCHAR(10)', nullable: false, default: "'BASIC'" },
        { name: 'created_at', logicalName: '가입일시', type: 'DATETIME', nullable: false, default: 'CURRENT_TIMESTAMP' },
      ],
    },
    {
      op: 'createTable', name: 'orders', logicalName: '주문',
      columns: [
        { name: 'order_id', type: 'BIGINT', primaryKey: true, autoIncrement: true },
        { name: 'amount', logicalName: '금액', type: 'DECIMAL(12,2)', nullable: false, default: '0' },
        { name: 'memo', type: 'TEXT' },
      ],
    },
    { op: 'addRelation', parent: 'member', child: 'orders', onDelete: 'CASCADE' },
    { op: 'addIndex', table: 'orders', columns: ['member_id', 'amount'], name: 'ix_orders_member_amount' },
  ]).schema;
}

for (const target of [mariadb, oracle, mssql]) {
  const dialect = getDialect(target.id);
  const connector = getConnector(target.id);

  async function push(config: ConnectionConfig, schema: Schema, links: ReturnType<typeof toLink>[] = []) {
    const db = await connector.introspect(config);
    const plan = planPush(schema, db.schema, { dialect, links });
    const statements = generateStatements(plan.diff, dialect, plan.defaultSelected);
    const result = await connector.execute(config, statements.map((s) => s.sql));
    return { plan, statements, result };
  }
  async function remaining(config: ConnectionConfig, schema: Schema) {
    const db = await connector.introspect(config);
    return planPush(schema, db.schema, { dialect }).diff.changes.map((c) => c.summary);
  }

  describe.skipIf(!target.url)(`${dialect.label} 실제 서버`, () => {
    afterAll(() => target.cleanup());

    it('타입 검사가 실패라고 한 것만 실제로 실패한다', async () => {
      const config = await target.fresh();
      const mismatches = await typeRuleMismatches(target.id, async (sqls) => (await connector.execute(config, sqls)).results.find((r) => !r.ok)?.error ?? null);
      expect(mismatches).toEqual([]);
    }, 180000);

    it('연결 확인, ERD로 만들고 다시 읽으면 ERD와 같다 (한글 코멘트, IDENTITY, UNIQUE, 기본값, FK CASCADE, 복합 인덱스)', async () => {
      const config = await target.fresh();
      expect((await connector.test(config)).serverVersion).toMatch(target.version);
      const schema = erd();
      const { result, statements } = await push(config, schema);
      expect(result.results.filter((r) => !r.ok)).toEqual([]);
      expect(statements.every((s) => s.category === 'create')).toBe(true);
      expect(await remaining(config, schema)).toEqual([]);

      const { schema: read } = await connector.introspect(config);
      const member = read.tables.find((t) => t.name === 'member')!;
      expect(member.logicalName).toBe('회원');
      expect(member.columns.find((c) => c.name === 'email')?.logicalName).toBe('이메일');
      expect(member.columns[0]).toMatchObject({ name: 'member_id', primaryKey: true, autoIncrement: true });
      expect(read.relations[0]).toMatchObject({ onDelete: 'CASCADE' });
    }, 120_000);

    it('ERD를 고치면 바뀐 부분만 실행하고 데이터는 남는다 (길이·기본값·NULL 변경, 컬럼 추가·이름 변경, 인덱스)', async () => {
      const config = await target.fresh();
      const schema = erd();
      await push(config, schema);
      await target.run(config, "INSERT INTO member (email) VALUES ('a@a.com')");

      const next = cloneSchema(schema);
      const member = next.tables.find((t) => t.name === 'member')!;
      const orders = next.tables.find((t) => t.name === 'orders')!;
      member.columns.find((c) => c.name === 'email')!.length = '200'; // UNIQUE가 걸린 컬럼
      member.columns.find((c) => c.name === 'grade')!.defaultValue = "'GOLD'";
      member.columns.find((c) => c.name === 'created_at')!.nullable = true;
      const phone = addColumn(next, member.id, { name: 'phone', logicalName: '전화번호', type: 'VARCHAR', length: '20' });
      addIndex(next, member.id, { columnIds: [phone.id] });
      orders.columns.find((c) => c.name === 'memo')!.name = 'note';
      orders.indexes = [];

      const first = await connector.introspect(config);
      const plan = planPush(next, first.schema, { dialect });
      expect(plan.renames).toMatchObject([{ kind: 'column', dbName: 'memo', erdName: 'note' }]);
      const { result } = await push(config, next, plan.renames.map(toLink));
      expect(result.results.filter((r) => !r.ok)).toEqual([]);
      expect(await remaining(config, next)).toEqual([]);
      const rows = await target.run(config, 'SELECT email FROM member');
      expect(rows.map((r) => r.email ?? r.EMAIL)).toEqual(['a@a.com']);
    }, 120_000);

    it.skipIf(dialect.id !== 'oracle' && dialect.id !== 'mssql')('함수 기반 인덱스(Oracle)·필터 인덱스(SQL Server)를 만들고 다시 읽으면 ERD와 같다', async () => {
      const config = await target.fresh();
      const schema = erd();
      const member = schema.tables.find((t) => t.name === 'member')!;
      if (dialect.id === 'oracle') addIndex(schema, member.id, { name: 'ix_member_email_upper', columnIds: [], expression: 'UPPER("EMAIL")' });
      else addIndex(schema, member.id, { name: 'ix_member_grade_live', columnIds: [member.columns.find((c) => c.name === 'grade')!.id], where: 'created_at IS NOT NULL' });
      const { result } = await push(config, schema);
      expect(result.results.filter((r) => !r.ok)).toEqual([]);
      expect(await remaining(config, schema)).toEqual([]);
      const { schema: read, warnings } = await connector.introspect(config);
      expect(warnings).toEqual([]);
      const index = read.tables.find((t) => t.name === 'member')!.indexes.find((i) => /ix_member_(email_upper|grade_live)/.test(i.name))!;
      if (dialect.id === 'oracle') expect(index).toMatchObject({ columnIds: [], expression: 'UPPER("EMAIL")' });
      else expect(index.where).toMatch(/created_at\]? IS NOT NULL/i);
    }, 120_000);

    it('CHECK 제약과 계산 컬럼을 만들고 다시 읽으면 ERD와 같고, 바꾼 것도 내보낸다', async () => {
      const config = await target.fresh();
      const schema = applyCommands(emptySchema(), [
        { op: 'createTable', name: 'item', logicalName: '품목', columns: [
          { name: 'item_id', type: 'INT', primaryKey: true },
          { name: 'qty', type: 'INT', nullable: false },
          { name: 'price', type: 'DECIMAL(10,2)', nullable: false },
          // Oracle은 VIRTUAL만, PostgreSQL은 STORED만 — 나머지는 둘 다
          { name: 'total', type: 'DECIMAL(12,2)', generated: 'qty * price', generatedStored: dialect.id === 'mssql' },
        ] },
        { op: 'addCheck', table: 'item', name: 'ck_item_qty', expression: 'qty >= 0' },
      ]).schema;
      const { result } = await push(config, schema);
      expect(result.results.filter((r) => !r.ok)).toEqual([]);
      expect(await remaining(config, schema)).toEqual([]);
      const { schema: read } = await connector.introspect(config);
      const item = read.tables.find((t) => t.name === 'item')!;
      expect(item.columns.find((c) => c.name === 'total')!.generated?.expression).toMatch(/qty/i);
      expect(item.checks?.map((k) => k.name.toLowerCase())).toContain('ck_item_qty');

      const next = applyCommands(schema, [
        { op: 'dropCheck', table: 'item', name: 'ck_item_qty' },
        { op: 'addCheck', table: 'item', name: 'ck_item_price', expression: 'price > 0' },
        { op: 'updateColumn', table: 'item', column: 'total', changes: { generated: 'qty * price * 2' } },
      ]).schema;
      const second = await push(config, next);
      expect(second.result.results.filter((r) => !r.ok)).toEqual([]);
      expect(await remaining(config, next)).toEqual([]);
    }, 120_000);

    it('맞춘 뒤 ERD에서 단 논리명은 "ERD에서 바뀜"으로 내보내고, 실행 후 다시 비교하면 0건', async () => {
      const config = await target.fresh();
      await logicalNameRoundTrip(config, dialect, connector);
    }, 120_000);

    it('FK 변경(ON DELETE SET NULL)과 UNIQUE 해제, 테이블 추가도 왕복된다', async () => {
      const config = await target.fresh();
      const schema = erd();
      await push(config, schema);
      const next = cloneSchema(schema);
      const member = next.tables.find((t) => t.name === 'member')!;
      const orders = next.tables.find((t) => t.name === 'orders')!;
      member.columns.find((c) => c.name === 'email')!.unique = false;
      orders.columns.find((c) => c.name === 'member_id')!.nullable = true;
      next.relations[0].onDelete = 'SET NULL';
      const withCoupon = applyCommands(next, [
        { op: 'createTable', name: 'coupon', logicalName: '쿠폰', columns: [{ name: 'coupon_id', type: 'BIGINT', primaryKey: true, autoIncrement: true }, { name: 'title', type: 'VARCHAR(100)', nullable: false }] },
        { op: 'addRelation', parent: 'member', child: 'coupon' },
      ]).schema;
      const { result } = await push(config, withCoupon);
      expect(result.results.filter((r) => !r.ok)).toEqual([]);
      expect(await remaining(config, withCoupon)).toEqual([]);
    }, 120_000);
  });
}
