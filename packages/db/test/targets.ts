// 실제 DB 테스트용 임시 공간 (MySQL·MariaDB·PostgreSQL·Oracle·SQL Server). 주소 환경변수가 없으면 url이 비어 테스트를 건너뛴다.
//   ERD_TEST_MYSQL=mysql://root:pw@127.0.0.1:3306   ERD_TEST_MARIADB=mysql://root:pw@127.0.0.1:3307
//   ERD_TEST_POSTGRES=postgres://postgres:pw@127.0.0.1:5432
//   ERD_TEST_ORACLE=oracle://system:pw@127.0.0.1:1521/FREEPDB1   ERD_TEST_MSSQL=mssql://sa:Passw0rd!@127.0.0.1:1433

import mysql from 'mysql2/promise';
import pg from 'pg';
import oracledb from 'oracledb';
import sql from 'mssql';
import type { DialectId } from '@erd/core';
import type { ConnectionConfig } from '../src';

export interface Target {
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

export const suffix = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const parse = (u: string) => {
  const url = new URL(u);
  return { host: url.hostname, port: Number(url.port), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), path: url.pathname.slice(1) };
};

/** MySQL 계열 (MySQL·MariaDB는 같은 드라이버) */
function mysqlFamily(id: 'mysql' | 'mariadb', url: string | undefined, version: RegExp): Target {
  const made: string[] = [];
  const admin = (u: string) => {
    const p = parse(u);
    return mysql.createConnection({ host: p.host, port: p.port, user: p.user, password: p.password, multipleStatements: true });
  };
  return {
    id,
    url,
    version,
    async fresh() {
      const p = parse(this.url!);
      const name = `erd_it_${suffix()}`;
      const conn = await admin(this.url!);
      await conn.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4`);
      await conn.end();
      made.push(name);
      return { dialect: id, host: p.host, port: p.port, user: p.user, password: p.password, database: name };
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
}

export const mysqlTarget = mysqlFamily('mysql', process.env.ERD_TEST_MYSQL, /^MySQL/);
export const mysql56Target = mysqlFamily('mysql', process.env.ERD_TEST_MYSQL56, /^MySQL/);
export const mariadb = mysqlFamily('mariadb', process.env.ERD_TEST_MARIADB, /^MariaDB/);

export const oracle: Target = (() => {
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

export const mssql: Target = (() => {
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

export const postgres: Target = (() => {
  const made: string[] = [];
  const client = (u: string, database = 'postgres') => {
    const p = parse(u);
    return new pg.Client({ host: p.host, port: p.port, user: p.user, password: p.password, database });
  };
  return {
    id: 'postgresql',
    url: process.env.ERD_TEST_POSTGRES,
    version: /^PostgreSQL/,
    async fresh() {
      const p = parse(this.url!);
      const name = `erd_it_${suffix()}`;
      const c = client(this.url!);
      await c.connect();
      await c.query(`CREATE DATABASE ${name}`);
      await c.end();
      made.push(name);
      return { dialect: 'postgresql', host: p.host, port: p.port, user: p.user, password: p.password, database: name };
    },
    async cleanup() {
      if (!this.url || !made.length) return;
      const c = client(this.url);
      await c.connect();
      for (const n of made) await c.query(`DROP DATABASE IF EXISTS ${n} WITH (FORCE)`).catch(() => {});
      await c.end();
    },
    async run(cfg, text) {
      const c = client(this.url!, cfg.database);
      await c.connect();
      try {
        return (await c.query(text)).rows as Record<string, unknown>[];
      } finally {
        await c.end();
      }
    },
  };
})();
