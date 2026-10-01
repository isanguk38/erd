import { describe, expect, it } from 'vitest';
import { generateCreateSql, getDialect, parseDdl, diffIncoming } from '@erd/core';
import { introspectMysql, mysqlColumnFromRow, type ColumnRow } from '../src/mysql';

const col = (partial: Partial<ColumnRow>): ColumnRow => ({
  TABLE_NAME: 't', COLUMN_NAME: 'c', DATA_TYPE: 'varchar', COLUMN_TYPE: 'varchar(10)', IS_NULLABLE: 'YES',
  COLUMN_DEFAULT: null, EXTRA: '', COLUMN_COMMENT: '', ...partial,
});

describe('MySQL 컬럼 해석', () => {
  it('타입과 길이', () => {
    expect(mysqlColumnFromRow(col({ DATA_TYPE: 'int', COLUMN_TYPE: 'int(11) unsigned' }))).toMatchObject({ type: 'INT UNSIGNED', length: '' });
    expect(mysqlColumnFromRow(col({ DATA_TYPE: 'tinyint', COLUMN_TYPE: 'tinyint(1)' }))).toMatchObject({ type: 'BOOLEAN', length: '' });
    expect(mysqlColumnFromRow(col({ DATA_TYPE: 'decimal', COLUMN_TYPE: 'decimal(12,2)' }))).toMatchObject({ type: 'DECIMAL', length: '12,2' });
    expect(mysqlColumnFromRow(col({ DATA_TYPE: 'enum', COLUMN_TYPE: "enum('A','B C')" }))).toMatchObject({ type: 'ENUM', length: "'A','B C'" });
  });

  it('기본값: MySQL 8과 MariaDB 표현 차이를 맞춘다', () => {
    expect(mysqlColumnFromRow(col({ COLUMN_DEFAULT: 'READY' })).defaultValue).toBe("'READY'");
    expect(mysqlColumnFromRow(col({ COLUMN_DEFAULT: "'READY'" })).defaultValue).toBe("'READY'");
    expect(mysqlColumnFromRow(col({ COLUMN_DEFAULT: 'NULL' })).defaultValue).toBe(null);
    expect(mysqlColumnFromRow(col({ DATA_TYPE: 'int', COLUMN_TYPE: 'int', COLUMN_DEFAULT: '0' })).defaultValue).toBe('0');
    expect(mysqlColumnFromRow(col({ DATA_TYPE: 'datetime', COLUMN_TYPE: 'datetime', COLUMN_DEFAULT: 'CURRENT_TIMESTAMP', EXTRA: 'DEFAULT_GENERATED' })).defaultValue).toBe('CURRENT_TIMESTAMP');
    expect(mysqlColumnFromRow(col({ DATA_TYPE: 'datetime', COLUMN_TYPE: 'datetime', COLUMN_DEFAULT: 'current_timestamp()' })).defaultValue).toBe('CURRENT_TIMESTAMP()');
  });
});

describe('MySQL information_schema 읽기', () => {
  it('ERD로 만든 DB를 읽으면 ERD와 같다 (FK용 자동 인덱스는 무시)', async () => {
    const erd = parseDdl(`
      CREATE TABLE member (member_id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY COMMENT '회원번호', email VARCHAR(100) NOT NULL UNIQUE) COMMENT='회원';
      CREATE TABLE orders (order_id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, member_id BIGINT NOT NULL,
        CONSTRAINT fk_orders_member FOREIGN KEY (member_id) REFERENCES member (member_id) ON DELETE CASCADE);
    `).schema;
    expect(generateCreateSql(erd, getDialect('mysql'))).toContain('CREATE UNIQUE INDEX `ux_member_email`');

    const rows: Record<string, Record<string, unknown>[]> = {
      TABLES: [
        { TABLE_NAME: 'member', TABLE_COMMENT: '회원' },
        { TABLE_NAME: 'orders', TABLE_COMMENT: '' },
      ],
      COLUMNS: [
        { ...col({ TABLE_NAME: 'member', COLUMN_NAME: 'member_id', DATA_TYPE: 'bigint', COLUMN_TYPE: 'bigint', IS_NULLABLE: 'NO', EXTRA: 'auto_increment', COLUMN_COMMENT: '회원번호' }) },
        { ...col({ TABLE_NAME: 'member', COLUMN_NAME: 'email', COLUMN_TYPE: 'varchar(100)', IS_NULLABLE: 'NO' }) },
        { ...col({ TABLE_NAME: 'orders', COLUMN_NAME: 'order_id', DATA_TYPE: 'bigint', COLUMN_TYPE: 'bigint', IS_NULLABLE: 'NO', EXTRA: 'auto_increment' }) },
        { ...col({ TABLE_NAME: 'orders', COLUMN_NAME: 'member_id', DATA_TYPE: 'bigint', COLUMN_TYPE: 'bigint', IS_NULLABLE: 'NO' }) },
      ],
      KEY_COLUMN_USAGE: [
        { CONSTRAINT_NAME: 'fk_orders_member', TABLE_NAME: 'orders', COLUMN_NAME: 'member_id', REFERENCED_TABLE_SCHEMA: 'shop', REFERENCED_TABLE_NAME: 'member', REFERENCED_COLUMN_NAME: 'member_id', DELETE_RULE: 'CASCADE', UPDATE_RULE: 'RESTRICT' },
      ],
      STATISTICS: [
        { TABLE_NAME: 'member', INDEX_NAME: 'PRIMARY', NON_UNIQUE: 0, COLUMN_NAME: 'member_id' },
        { TABLE_NAME: 'member', INDEX_NAME: 'ux_member_email', NON_UNIQUE: 0, COLUMN_NAME: 'email' },
        { TABLE_NAME: 'orders', INDEX_NAME: 'PRIMARY', NON_UNIQUE: 0, COLUMN_NAME: 'order_id' },
        { TABLE_NAME: 'orders', INDEX_NAME: 'fk_orders_member', NON_UNIQUE: 1, COLUMN_NAME: 'member_id' },
      ],
    };
    const query = async (sql: string) => {
      const table = ['KEY_COLUMN_USAGE', 'STATISTICS', 'COLUMNS', 'TABLES'].find((t) => sql.includes(`information_schema.${t}`))!;
      return rows[table] as Record<string, any>[];
    };
    const { schema, warnings } = await introspectMysql(query, 'shop');
    expect(warnings).toEqual([]);
    expect(schema.tables[1].indexes).toEqual([]); // FK 자동 인덱스 제외
    expect(schema.relations[0]).toMatchObject({ name: 'fk_orders_member', onDelete: 'CASCADE', onUpdate: 'RESTRICT' });
    // RESTRICT = NO ACTION (MySQL)이므로 차이 없음
    expect(diffIncoming(erd, schema, getDialect('mysql')).changes.map((c) => c.summary)).toEqual([]);
  });
});
