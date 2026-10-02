// Oracle·SQL Server 구조 읽기: 실제 DB가 돌려주는 모양의 행으로 확인한다 (실제 서버 테스트는 *.integration.test.ts)
import { describe, expect, it } from 'vitest';
import { applyCommands, emptySchema, getDialect, planPush, type Schema } from '@erd/core';
import { fromOracleName, introspectMssql, introspectOracle, mssqlDefault, mssqlType, oracleDefault, oracleType } from '../src';

/** ERD에서 만든 테이블 (이것을 DB에 만들었다고 보고 DB가 돌려주는 행을 아래에 적었다) */
function erd(): Schema {
  return applyCommands(emptySchema(), [
    { op: 'createTable', name: 'member', logicalName: '회원', columns: [
      { name: 'member_id', logicalName: '회원번호', type: 'BIGINT', primaryKey: true, autoIncrement: true },
      { name: 'email', logicalName: '이메일', type: 'VARCHAR(100)', nullable: false, unique: true },
      { name: 'is_active', type: 'BOOLEAN', nullable: false, default: '1' },
      { name: 'created_at', type: 'DATETIME', nullable: false, default: 'CURRENT_TIMESTAMP' },
    ] },
    { op: 'createTable', name: 'orders', logicalName: '주문', columns: [
      { name: 'order_id', type: 'BIGINT', primaryKey: true, autoIncrement: true },
      { name: 'amount', type: 'DECIMAL(12,2)', nullable: false, default: '0' },
      { name: 'memo', type: 'TEXT' },
    ] },
    { op: 'addRelation', parent: 'member', child: 'orders', onDelete: 'CASCADE' },
    { op: 'addIndex', table: 'orders', columns: ['member_id', 'amount'], name: 'ix_orders_member_amount' },
  ]).schema;
}

describe('Oracle 구조 읽기', () => {
  it('타입·기본값·이름 변환', () => {
    expect(oracleType({ DATA_TYPE: 'NUMBER', DATA_PRECISION: 19, DATA_SCALE: 0 })).toEqual({ type: 'BIGINT', length: '' });
    expect(oracleType({ DATA_TYPE: 'NUMBER', DATA_PRECISION: 12, DATA_SCALE: 2 })).toEqual({ type: 'NUMBER', length: '12,2' });
    expect(oracleType({ DATA_TYPE: 'NUMBER', DATA_PRECISION: 7, DATA_SCALE: 0 })).toEqual({ type: 'NUMBER', length: '7' });
    expect(oracleType({ DATA_TYPE: 'NUMBER', DATA_PRECISION: null, DATA_SCALE: null })).toEqual({ type: 'NUMBER', length: '' });
    expect(oracleType({ DATA_TYPE: 'VARCHAR2', CHAR_LENGTH: 100, DATA_LENGTH: 400 })).toEqual({ type: 'VARCHAR2', length: '100' });
    expect(oracleType({ DATA_TYPE: 'TIMESTAMP(6) WITH TIME ZONE' })).toEqual({ type: 'TIMESTAMP WITH TIME ZONE', length: '' });
    expect(oracleDefault("'BASIC' \n")).toBe("'BASIC'");
    expect(oracleDefault('NULL ')).toBeNull();
    expect(fromOracleName('MEMBER_ID')).toBe('member_id');
    expect(fromOracleName('createdAt')).toBe('createdAt');
  });

  it('ERD로 만든 테이블을 다시 읽으면 바뀐 것이 없다 (대문자 이름, NUMBER, IDENTITY, 코멘트, PK/UNIQUE/인덱스/FK)', async () => {
    const rows: Record<string, Record<string, unknown>[]> = {
      ALL_TABLES: [
        { TABLE_NAME: 'MEMBER', COMMENTS: '회원' },
        { TABLE_NAME: 'ORDERS', COMMENTS: '주문' },
      ],
      ALL_TAB_COLS: [
        { TABLE_NAME: 'MEMBER', COLUMN_NAME: 'MEMBER_ID', DATA_TYPE: 'NUMBER', DATA_PRECISION: 19, DATA_SCALE: 0, NULLABLE: 'N', DATA_DEFAULT: '"ERD"."ISEQ$$_7".nextval', IDENTITY_COLUMN: 'YES', VIRTUAL_COLUMN: 'NO', COMMENTS: '회원번호' },
        { TABLE_NAME: 'MEMBER', COLUMN_NAME: 'EMAIL', DATA_TYPE: 'VARCHAR2', CHAR_LENGTH: 100, NULLABLE: 'N', DATA_DEFAULT: null, IDENTITY_COLUMN: 'NO', VIRTUAL_COLUMN: 'NO', COMMENTS: '이메일' },
        { TABLE_NAME: 'MEMBER', COLUMN_NAME: 'IS_ACTIVE', DATA_TYPE: 'NUMBER', DATA_PRECISION: 1, DATA_SCALE: 0, NULLABLE: 'N', DATA_DEFAULT: '1 ', IDENTITY_COLUMN: 'NO', VIRTUAL_COLUMN: 'NO', COMMENTS: null },
        { TABLE_NAME: 'MEMBER', COLUMN_NAME: 'CREATED_AT', DATA_TYPE: 'TIMESTAMP(6)', NULLABLE: 'N', DATA_DEFAULT: 'CURRENT_TIMESTAMP\n', IDENTITY_COLUMN: 'NO', VIRTUAL_COLUMN: 'NO', COMMENTS: null },
        { TABLE_NAME: 'ORDERS', COLUMN_NAME: 'ORDER_ID', DATA_TYPE: 'NUMBER', DATA_PRECISION: 19, DATA_SCALE: 0, NULLABLE: 'N', DATA_DEFAULT: null, IDENTITY_COLUMN: 'YES', VIRTUAL_COLUMN: 'NO', COMMENTS: null },
        { TABLE_NAME: 'ORDERS', COLUMN_NAME: 'AMOUNT', DATA_TYPE: 'NUMBER', DATA_PRECISION: 12, DATA_SCALE: 2, NULLABLE: 'N', DATA_DEFAULT: '0', IDENTITY_COLUMN: 'NO', VIRTUAL_COLUMN: 'NO', COMMENTS: null },
        { TABLE_NAME: 'ORDERS', COLUMN_NAME: 'MEMO', DATA_TYPE: 'CLOB', NULLABLE: 'Y', DATA_DEFAULT: null, IDENTITY_COLUMN: 'NO', VIRTUAL_COLUMN: 'NO', COMMENTS: null },
        { TABLE_NAME: 'ORDERS', COLUMN_NAME: 'MEMBER_ID', DATA_TYPE: 'NUMBER', DATA_PRECISION: 19, DATA_SCALE: 0, NULLABLE: 'N', DATA_DEFAULT: null, IDENTITY_COLUMN: 'NO', VIRTUAL_COLUMN: 'NO', COMMENTS: '회원번호' },
      ],
      ALL_CONSTRAINTS: [
        { CONSTRAINT_NAME: 'PK_MEMBER', CONSTRAINT_TYPE: 'P', TABLE_NAME: 'MEMBER', COLUMN_NAME: 'MEMBER_ID', INDEX_NAME: 'PK_MEMBER' },
        { CONSTRAINT_NAME: 'PK_ORDERS', CONSTRAINT_TYPE: 'P', TABLE_NAME: 'ORDERS', COLUMN_NAME: 'ORDER_ID', INDEX_NAME: 'PK_ORDERS' },
        { CONSTRAINT_NAME: 'FK_ORDERS_MEMBER', CONSTRAINT_TYPE: 'R', TABLE_NAME: 'ORDERS', COLUMN_NAME: 'MEMBER_ID', R_OWNER: 'ERD', R_CONSTRAINT_NAME: 'PK_MEMBER', DELETE_RULE: 'CASCADE' },
      ],
      ALL_INDEXES: [
        { INDEX_NAME: 'PK_MEMBER', TABLE_NAME: 'MEMBER', UNIQUENESS: 'UNIQUE', INDEX_TYPE: 'NORMAL', COLUMN_NAME: 'MEMBER_ID' },
        { INDEX_NAME: 'UX_MEMBER_EMAIL', TABLE_NAME: 'MEMBER', UNIQUENESS: 'UNIQUE', INDEX_TYPE: 'NORMAL', COLUMN_NAME: 'EMAIL' },
        { INDEX_NAME: 'PK_ORDERS', TABLE_NAME: 'ORDERS', UNIQUENESS: 'UNIQUE', INDEX_TYPE: 'NORMAL', COLUMN_NAME: 'ORDER_ID' },
        { INDEX_NAME: 'IX_ORDERS_MEMBER_AMOUNT', TABLE_NAME: 'ORDERS', UNIQUENESS: 'NONUNIQUE', INDEX_TYPE: 'NORMAL', COLUMN_NAME: 'MEMBER_ID' },
        { INDEX_NAME: 'IX_ORDERS_MEMBER_AMOUNT', TABLE_NAME: 'ORDERS', UNIQUENESS: 'NONUNIQUE', INDEX_TYPE: 'NORMAL', COLUMN_NAME: 'AMOUNT' },
        { INDEX_NAME: 'IX_FN', TABLE_NAME: 'ORDERS', UNIQUENESS: 'NONUNIQUE', INDEX_TYPE: 'FUNCTION-BASED NORMAL', COLUMN_NAME: 'SYS_NC00005$' },
      ],
    };
    const query = async (sql: string) => {
      const key = Object.keys(rows).find((k) => new RegExp(`FROM ${k}\\b`).test(sql));
      return key ? rows[key] : [];
    };
    const { schema, warnings } = await introspectOracle(query, 'ERD');
    expect(schema.tables.map((t) => t.name)).toEqual(['member', 'orders']);
    const member = schema.tables[0];
    expect(member.columns.map((c) => `${c.name}:${c.type}${c.autoIncrement ? ':AI' : ''}`)).toEqual(['member_id:BIGINT:AI', 'email:VARCHAR2', 'is_active:BOOLEAN', 'created_at:TIMESTAMP']);
    expect(member.columns[0].defaultValue).toBeNull(); // IDENTITY 내부 시퀀스는 기본값으로 안 가져온다
    expect(member.primaryKeyName).toBe('pk_member');
    expect(schema.relations[0]).toMatchObject({ name: 'fk_orders_member', onDelete: 'CASCADE', onUpdate: 'NO ACTION' });
    expect(warnings).toEqual([expect.stringContaining('함수 기반 인덱스')]);

    const plan = planPush(erd(), schema, { dialect: getDialect('oracle') });
    expect(plan.diff.changes.map((c) => c.summary)).toEqual([]);
  });
});

describe('SQL Server 구조 읽기', () => {
  it('타입·기본값 변환', () => {
    expect(mssqlType({ type_name: 'nvarchar', max_length: 200 })).toEqual({ type: 'NVARCHAR', length: '100' });
    expect(mssqlType({ type_name: 'nvarchar', max_length: -1 })).toEqual({ type: 'NVARCHAR', length: 'MAX' });
    expect(mssqlType({ type_name: 'varchar', max_length: 100 })).toEqual({ type: 'VARCHAR', length: '100' });
    expect(mssqlType({ type_name: 'decimal', precision: 12, scale: 2 })).toEqual({ type: 'DECIMAL', length: '12,2' });
    expect(mssqlType({ type_name: 'datetime2', max_length: 8 })).toEqual({ type: 'DATETIME2', length: '' });
    expect(mssqlDefault('((0))')).toBe('0');
    expect(mssqlDefault("(N'가나')")).toBe("'가나'");
    expect(mssqlDefault('(getdate())')).toBe('getdate()');
    expect(mssqlDefault(null)).toBeNull();
  });

  it('ERD로 만든 테이블을 다시 읽으면 바뀐 것이 없다 (IDENTITY, BIT, DATETIME2, NVARCHAR(MAX), 설명, PK/UNIQUE/인덱스/FK)', async () => {
    const rows: Record<string, Record<string, unknown>[]> = {
      tables: [
        { name: 'member', comment: '회원' },
        { name: 'orders', comment: '주문' },
      ],
      columns: [
        { table_name: 'member', name: 'member_id', type_name: 'bigint', max_length: 8, is_nullable: false, is_identity: true, is_computed: false, default_def: null, comment: '회원번호' },
        { table_name: 'member', name: 'email', type_name: 'varchar', max_length: 100, is_nullable: false, is_identity: false, is_computed: false, default_def: null, comment: '이메일' },
        { table_name: 'member', name: 'is_active', type_name: 'bit', max_length: 1, is_nullable: false, is_identity: false, is_computed: false, default_def: '((1))', comment: null },
        { table_name: 'member', name: 'created_at', type_name: 'datetime2', max_length: 8, is_nullable: false, is_identity: false, is_computed: false, default_def: '(getdate())', comment: null },
        { table_name: 'orders', name: 'order_id', type_name: 'bigint', max_length: 8, is_nullable: false, is_identity: true, is_computed: false, default_def: null, comment: null },
        { table_name: 'orders', name: 'amount', type_name: 'decimal', precision: 12, scale: 2, is_nullable: false, is_identity: false, is_computed: false, default_def: '((0))', comment: null },
        { table_name: 'orders', name: 'memo', type_name: 'nvarchar', max_length: -1, is_nullable: true, is_identity: false, is_computed: false, default_def: null, comment: null },
        { table_name: 'orders', name: 'member_id', type_name: 'bigint', max_length: 8, is_nullable: false, is_identity: false, is_computed: false, default_def: null, comment: '회원번호' },
      ],
      indexes: [
        { table_name: 'member', name: 'PK_member', is_primary_key: true, is_unique: true, is_unique_constraint: false, column_name: 'member_id' },
        { table_name: 'member', name: 'ux_member_email', is_primary_key: false, is_unique: true, is_unique_constraint: false, column_name: 'email' },
        { table_name: 'orders', name: 'PK_orders', is_primary_key: true, is_unique: true, is_unique_constraint: false, column_name: 'order_id' },
        { table_name: 'orders', name: 'ix_orders_member_amount', is_primary_key: false, is_unique: false, is_unique_constraint: false, column_name: 'member_id' },
        { table_name: 'orders', name: 'ix_orders_member_amount', is_primary_key: false, is_unique: false, is_unique_constraint: false, column_name: 'amount' },
      ],
      foreign_keys: [
        { name: 'fk_orders_member', table_name: 'orders', ref_schema: 'dbo', ref_table: 'member', column_name: 'member_id', ref_column: 'member_id', on_delete: 'CASCADE', on_update: 'NO_ACTION' },
      ],
    };
    const query = async (sql: string) => {
      if (/FROM sys\.tables t JOIN/.test(sql)) return rows.tables;
      if (/FROM sys\.columns c/.test(sql)) return rows.columns;
      if (/FROM sys\.indexes i/.test(sql)) return rows.indexes;
      if (/FROM sys\.foreign_keys fk/.test(sql)) return rows.foreign_keys;
      return [];
    };
    const { schema } = await introspectMssql(query, 'dbo');
    const member = schema.tables.find((t) => t.name === 'member')!;
    expect(member.primaryKeyName).toBe('PK_member');
    expect(member.logicalName).toBe('회원');
    expect(schema.relations[0]).toMatchObject({ onDelete: 'CASCADE', onUpdate: 'NO ACTION' });
    const plan = planPush(erd(), schema, { dialect: getDialect('mssql') });
    expect(plan.diff.changes.map((c) => c.summary)).toEqual([]);
  });
});

describe('Oracle 오류 안내', () => {
  it('권한이 부족하면 필요한 권한을 알려준다', async () => {
    const { oracleHint } = await import('../src/oracle');
    expect(oracleHint('CREATE TABLE t (id NUMBER(19) GENERATED BY DEFAULT AS IDENTITY NOT NULL)', 'ORA-01031: insufficient privileges')).toContain('CREATE SEQUENCE');
    expect(oracleHint('CREATE INDEX ix ON t (a)', 'ORA-01031: insufficient privileges')).toContain('CREATE INDEX');
    expect(oracleHint('x', 'ORA-01950: no privileges on tablespace')).toContain('UNLIMITED TABLESPACE');
    expect(oracleHint('x', 'ORA-00942: table or view does not exist')).toBe('ORA-00942: table or view does not exist');
  });
});
