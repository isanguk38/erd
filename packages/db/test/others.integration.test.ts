// MariaDB·Oracle·SQL Server 실제 서버로 하는 왕복 테스트 (CI에서 컨테이너로 실행).
// 주소를 주면 실행하고, 없으면 건너뛴다:
//   ERD_TEST_MARIADB=mysql://root:pw@127.0.0.1:3307
//   ERD_TEST_ORACLE=oracle://system:pw@127.0.0.1:1521/FREEPDB1
//   ERD_TEST_MSSQL=mssql://sa:Passw0rd!@127.0.0.1:1433
// 테스트마다 임시 DB(Oracle은 임시 사용자)를 만들고 끝나면 지운다.

import { afterAll, describe, expect, it } from 'vitest';
import mysql from 'mysql2/promise';
import oracledb from 'oracledb';
import sql from 'mssql';
import { addColumn, addIndex, applyCommands, cloneSchema, emptySchema, generateStatements, getDialect, planPush, toLink, type DialectId, type Schema } from '@erd/core';
import { getConnector, type ConnectionConfig } from '../src';

interface Target {
  id: DialectId;
  url: string | undefined;
  /** 임시 공간을 만들고 그 연결 정보를 돌려준다 */
  fresh(): Promise<ConnectionConfig>;
  /** 정리 */
  cleanup(): Promise<void>;
  /** 테스트용 SQL 직접 실행 */
  run(config: ConnectionConfig, text: string): Promise<Record<string, unknown>[]>;
  version: RegExp;
}

const suffix = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const parse = (u: string) => {
  const url = new URL(u);
  return { host: url.hostname, port: Number(url.port), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), path: url.pathname.slice(1) };
};

const mariadb: Target = (() => {
  const made: string[] = [];
  const admin = (u: string) => {
    const p = parse(u);
    return mysql.createConnection({ host: p.host, port: p.port, user: p.user, password: p.password, multipleStatements: true });
  };
  return {
    id: 'mariadb',
    url: process.env.ERD_TEST_MARIADB,
    version: /^MariaDB/,
    async fresh() {
      const p = parse(this.url!);
      const name = `erd_it_${suffix()}`;
      const conn = await admin(this.url!);
      await conn.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4`);
      await conn.end();
      made.push(name);
      return { dialect: 'mariadb', host: p.host, port: p.port, user: p.user, password: p.password, database: name };
    },
    async cleanup() {
      if (!this.url || !made.length) return;
      const conn = await admin(this.url);
      for (const n of made) await conn.query(`DROP DATABASE IF EXISTS \`${n}\``);
      await conn.end();
    },
    async run(c, text) {
      const conn = await mysql.createConnection({ host: c.host, port: c.port, user: c.user, password: c.password, database: c.database, multipleStatements: true });
      const [rows] = await conn.query(text);
      await conn.end();
      return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
    },
  };
})();

const oracle: Target = (() => {
  const made: string[] = [];
  const admin = async (u: string) => {
    const p = parse(u);
    return oracledb.getConnection({ user: p.user, password: p.password, connectString: `${p.host}:${p.port}/${p.path}` });
  };
  return {
    id: 'oracle',
    url: process.env.ERD_TEST_ORACLE,
    version: /^Oracle/,
    async fresh() {
      const p = parse(this.url!);
      const user = `ERD_IT_${suffix()}`.toUpperCase().slice(0, 30);
      const password = 'ErdTest_123';
      const conn = await admin(this.url!);
      await conn.execute(`CREATE USER ${user} IDENTIFIED BY "${password}"`);
      await conn.execute(`GRANT CREATE SESSION, CREATE TABLE, CREATE SEQUENCE, UNLIMITED TABLESPACE TO ${user}`);
      await conn.close();
      made.push(user);
      return { dialect: 'oracle', host: p.host, port: p.port, user, password, database: p.path };
    },
    async cleanup() {
      if (!this.url || !made.length) return;
      const conn = await admin(this.url);
      for (const u of made) await conn.execute(`DROP USER ${u} CASCADE`).catch(() => {});
      await conn.close();
    },
    async run(c, text) {
      const conn = await oracledb.getConnection({ user: c.user, password: c.password, connectString: `${c.host}:${c.port}/${c.database}` });
      try {
        const r = await conn.execute(text, [], { outFormat: oracledb.OUT_FORMAT_OBJECT, autoCommit: true });
        return (r.rows ?? []) as Record<string, unknown>[];
      } finally {
        await conn.close();
      }
    },
  };
})();

const mssql: Target = (() => {
  const made: string[] = [];
  const pool = async (u: string, database?: string) => {
    const p = parse(u);
    return new sql.ConnectionPool({ server: p.host, port: p.port, user: p.user, password: p.password, database, options: { encrypt: false, trustServerCertificate: true } }).connect();
  };
  return {
    id: 'mssql',
    url: process.env.ERD_TEST_MSSQL,
    version: /^SQL Server/,
    async fresh() {
      const p = parse(this.url!);
      const name = `erd_it_${suffix()}`;
      const conn = await pool(this.url!);
      await conn.request().batch(`CREATE DATABASE [${name}] COLLATE Korean_Wansung_CI_AS`);
      await conn.close();
      made.push(name);
      return { dialect: 'mssql', host: p.host, port: p.port, user: p.user, password: p.password, database: name };
    },
    async cleanup() {
      if (!this.url || !made.length) return;
      const conn = await pool(this.url);
      for (const n of made) await conn.request().batch(`ALTER DATABASE [${n}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${n}]`).catch(() => {});
      await conn.close();
    },
    async run(c, text) {
      const conn = await pool(this.url!, c.database);
      try {
        return ((await conn.request().query(text)).recordset ?? []) as Record<string, unknown>[];
      } finally {
        await conn.close();
      }
    },
  };
})();

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
