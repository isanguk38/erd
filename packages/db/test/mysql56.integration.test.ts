// 오래된 MySQL 5.6에서 DB 구조 읽기 테스트.
// ERD_TEST_MYSQL56=mysql://root@127.0.0.1:3406 처럼 주소를 주면 실행하고, 없으면 건너뛴다.
// 5.6의 information_schema에는 GENERATION_EXPRESSION(계산 컬럼)·EXPRESSION(식 인덱스)·CHECK_CONSTRAINTS가 없다.

import { afterAll, describe, expect, it } from 'vitest';
import mysql from 'mysql2/promise';
import type { ConnectionConfig } from '../src';
import { mysqlConnector } from '../src/mysql';

const url = process.env.ERD_TEST_MYSQL56;
const created: string[] = [];

async function admin() {
  const u = new URL(url!);
  return mysql.createConnection({ host: u.hostname, port: Number(u.port), user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), multipleStatements: true });
}

afterAll(async () => {
  if (!url || !created.length) return;
  const conn = await admin();
  for (const name of created) await conn.query(`DROP DATABASE IF EXISTS \`${name}\``);
  await conn.end();
});

describe.skipIf(!url)('MySQL 5.6 구조 읽기', () => {
  it('테이블·컬럼·기본값·인덱스·외래키·코멘트를 읽는다', async () => {
    const u = new URL(url!);
    const name = `erd_it_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    created.push(name);
    const conn = await admin();
    await conn.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8`);
    await conn.query(`USE \`${name}\`;
      CREATE TABLE member (
        member_id BIGINT NOT NULL AUTO_INCREMENT COMMENT '회원번호',
        email VARCHAR(100) NOT NULL,
        grade VARCHAR(10) NOT NULL DEFAULT 'BASIC',
        point INT UNSIGNED NOT NULL DEFAULT 0,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (member_id),
        UNIQUE KEY uq_member_email (email),
        KEY idx_member_email_prefix (email(20))
      ) ENGINE=InnoDB COMMENT='회원';
      CREATE TABLE orders (
        order_id BIGINT NOT NULL AUTO_INCREMENT,
        member_id BIGINT NOT NULL,
        amount DECIMAL(12,2) NOT NULL DEFAULT 0,
        PRIMARY KEY (order_id),
        KEY idx_orders_member (member_id),
        CONSTRAINT fk_orders_member FOREIGN KEY (member_id) REFERENCES member (member_id) ON DELETE CASCADE
      ) ENGINE=InnoDB COMMENT='주문';`);
    await conn.end();

    const config: ConnectionConfig = { dialect: 'mysql', host: u.hostname, port: Number(u.port), user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), database: name };
    const { schema, serverVersion } = await mysqlConnector.introspect(config);
    expect(serverVersion).toMatch(/^MySQL 5\.6/);

    const member = schema.tables.find((t) => t.name === 'member')!;
    expect(member.logicalName).toBe('회원');
    const col = (n: string) => member.columns.find((c) => c.name === n)!;
    expect(col('member_id')).toMatchObject({ primaryKey: true, autoIncrement: true, logicalName: '회원번호' });
    expect(col('grade').defaultValue).toBe("'BASIC'");
    expect(col('point').type).toBe('INT UNSIGNED');
    expect(col('updated_at')).toMatchObject({ defaultValue: 'CURRENT_TIMESTAMP', onUpdate: 'CURRENT_TIMESTAMP' });
    expect(member.columns.every((c) => !c.generated)).toBe(true);
    expect(member.indexes.find((i) => i.name === 'uq_member_email')?.unique).toBe(true);
    expect(member.indexes.find((i) => i.name === 'idx_member_email_prefix')?.expression).toBe('`email`(20)');

    const orders = schema.tables.find((t) => t.name === 'orders')!;
    expect(orders.indexes.map((i) => i.name)).toContain('idx_orders_member');
    expect(schema.relations).toHaveLength(1);
    expect(schema.relations[0]).toMatchObject({ name: 'fk_orders_member', onDelete: 'CASCADE' });
  });
});
