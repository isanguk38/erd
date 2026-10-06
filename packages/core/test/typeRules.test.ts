import { describe, expect, it } from 'vitest';
import { applyCommands, autoFixColumnPatch, canAutoIncrement, columnTypeIssues, createColumn, diffSchemas, emptySchema, getDialect, lintSchema, tableTypeIssues, type Column, type DialectId } from '../src';

const col = (patch: Partial<Column>): Column => ({ ...createColumn({ name: 'c' }), type: 'INT', length: '', ...patch });
const codes = (dialect: DialectId, patch: Partial<Column>) => columnTypeIssues(dialect, col(patch)).map((i) => `${i.severity}:${i.code}`);
const errors = (dialect: DialectId, patch: Partial<Column>) => columnTypeIssues(dialect, col(patch)).filter((i) => i.severity === 'error').map((i) => i.code);
const ALL: DialectId[] = ['mysql', 'mariadb', 'postgresql', 'oracle', 'mssql'];

describe('타입 검사: 자동 증가', () => {
  it('정수가 아닌 타입의 자동 증가는 모든 DB에서 실패', () => {
    for (const d of ALL) expect(errors(d, { type: 'VARCHAR', length: '255', autoIncrement: true }), d).toContain('auto-increment-type');
  });
  it('정수 타입은 통과 (Oracle은 NUMBER(19)로 만들어도 통과)', () => {
    for (const d of ALL) {
      expect(errors(d, { type: 'BIGINT', autoIncrement: true }), d).toEqual([]);
      expect(errors(d, { type: 'INT', autoIncrement: true }), d).toEqual([]);
    }
    expect(errors('oracle', { type: 'NUMBER', length: '10', autoIncrement: true })).toEqual([]);
    expect(errors('mssql', { type: 'DECIMAL', length: '18,0', autoIncrement: true })).toEqual([]);
    expect(errors('mssql', { type: 'DECIMAL', length: '18,2', autoIncrement: true })).toContain('auto-increment-type');
  });
  it('BIGINT로 고치는 방법을 준다', () => {
    const [issue] = columnTypeIssues('mysql', col({ type: 'VARCHAR', length: '255', autoIncrement: true }));
    expect(issue!.fix!.patch).toMatchObject({ type: 'BIGINT', length: '' });
  });
  it('MySQL: 자동 증가에 기본값이 있으면 실패, 다른 DB는 무시', () => {
    expect(errors('mysql', { type: 'BIGINT', autoIncrement: true, defaultValue: '0' })).toContain('auto-increment-default');
    expect(codes('postgresql', { type: 'BIGINT', autoIncrement: true, defaultValue: '0' })).toContain('info:auto-increment-default-ignored');
  });
  it('테이블에 자동 증가가 둘이면 실패 (PostgreSQL은 허용), MySQL은 키가 아니면 실패', () => {
    const { schema } = applyCommands(emptySchema(), [
      { op: 'createTable', name: 't', columns: [{ name: 'a', type: 'INT', primaryKey: true, autoIncrement: true }, { name: 'b', type: 'INT', autoIncrement: true }] },
    ]);
    const t = schema.tables[0]!;
    expect(tableTypeIssues('mysql', t).map((i) => i.code)).toEqual(expect.arrayContaining(['auto-increment-multiple', 'auto-increment-key']));
    expect(tableTypeIssues('oracle', t).map((i) => i.code)).toContain('auto-increment-multiple');
    expect(tableTypeIssues('mssql', t).map((i) => i.code)).toContain('auto-increment-multiple');
    expect(tableTypeIssues('postgresql', t).map((i) => i.code)).not.toContain('auto-increment-multiple');
  });
});

describe('타입 검사: 날짜·시간', () => {
  it('MySQL·MariaDB·PostgreSQL: 괄호 숫자는 0~6', () => {
    for (const d of ['mysql', 'mariadb', 'postgresql'] as DialectId[]) {
      expect(errors(d, { type: 'DATETIME', length: '255' }), d).toContain('time-precision');
      expect(errors(d, { type: 'TIMESTAMP', length: '6' }), d).toEqual([]);
    }
  });
  it('Oracle·SQL Server는 날짜 길이를 쓰지 않는다고 알려 준다 (실패는 아님)', () => {
    expect(codes('oracle', { type: 'DATETIME', length: '255' })).toEqual(['info:length-ignored']);
    expect(codes('mssql', { type: 'DATETIME', length: '3' })).toEqual(['info:length-ignored']);
  });
  it('MySQL: DATE·JSON에 길이가 있으면 실패', () => {
    expect(errors('mysql', { type: 'DATE', length: '10' })).toContain('length-not-allowed');
    expect(errors('mysql', { type: 'JSON', length: '100' })).toContain('length-not-allowed');
  });
  it('MySQL: ON UPDATE는 날짜 컬럼에만, 자릿수는 컬럼과 같게', () => {
    expect(errors('mysql', { type: 'VARCHAR', length: '20', onUpdate: 'CURRENT_TIMESTAMP' })).toContain('on-update-type');
    const issue = columnTypeIssues('mysql', col({ type: 'DATETIME', length: '3', onUpdate: 'CURRENT_TIMESTAMP' })).find((i) => i.code === 'on-update-precision');
    expect(issue?.fix?.patch).toEqual({ onUpdate: 'CURRENT_TIMESTAMP(3)' });
    expect(errors('mysql', { type: 'DATETIME', length: '3', onUpdate: 'CURRENT_TIMESTAMP(3)' })).toEqual([]);
    expect(errors('mysql', { type: 'DATETIME', defaultValue: 'CURRENT_TIMESTAMP(6)' })).toContain('default-time-type');
    expect(errors('mysql', { type: 'DATE', defaultValue: 'CURRENT_TIMESTAMP' })).toContain('default-time-type');
  });
  it('생성 시각에 ON UPDATE는 주의', () => {
    expect(codes('mysql', { name: 'created_at', type: 'DATETIME', onUpdate: 'CURRENT_TIMESTAMP' })).toContain('warning:on-update-created');
    expect(codes('mysql', { name: 'updated_at', type: 'DATETIME', onUpdate: 'CURRENT_TIMESTAMP' })).toEqual([]);
  });
  it('ON UPDATE는 다른 DB에서 만들지 않는다고 알려 준다', () => {
    expect(codes('postgresql', { type: 'TIMESTAMP', onUpdate: 'CURRENT_TIMESTAMP' })).toContain('info:on-update-ignored');
  });
});

describe('타입 검사: 문자 길이', () => {
  it('MySQL: VARCHAR 길이 없음·16383 초과·CHAR 255 초과는 실패', () => {
    expect(errors('mysql', { type: 'VARCHAR', length: '' })).toContain('varchar-length-required');
    expect(errors('mysql', { type: 'VARCHAR', length: '20000' })).toContain('string-length');
    expect(errors('mysql', { type: 'CHAR', length: '256' })).toContain('string-length');
    expect(errors('mysql', { type: 'VARCHAR', length: 'abc' })).toContain('string-length');
  });
  it('PostgreSQL: VARCHAR 길이 없음은 통과(제한 없음)', () => {
    expect(errors('postgresql', { type: 'VARCHAR', length: '' })).toEqual([]);
  });
  it('Oracle: 4000 초과는 주의, 32767 초과는 실패', () => {
    expect(codes('oracle', { type: 'VARCHAR', length: '5000' })).toEqual(['warning:string-length']);
    expect(errors('oracle', { type: 'VARCHAR2', length: '40000' })).toContain('string-length');
    expect(errors('oracle', { type: 'VARCHAR2', length: '100 CHAR' })).toEqual([]);
  });
  it('SQL Server: NVARCHAR 4000·VARCHAR 8000 초과는 MAX로 고치게 한다', () => {
    const issue = columnTypeIssues('mssql', col({ type: 'NVARCHAR', length: '5000' })).find((i) => i.code === 'string-length');
    expect(issue?.fix?.patch).toEqual({ length: 'MAX' });
    expect(errors('mssql', { type: 'NVARCHAR', length: 'MAX' })).toEqual([]);
    expect(errors('mssql', { type: 'VARCHAR', length: '8000' })).toEqual([]);
  });
});

describe('타입 검사: 숫자', () => {
  it('DECIMAL 자릿수 범위', () => {
    expect(errors('mysql', { type: 'DECIMAL', length: '70,2' })).toContain('decimal-precision');
    expect(errors('mysql', { type: 'DECIMAL', length: '5,6' })).toContain('decimal-precision');
    expect(errors('mssql', { type: 'DECIMAL', length: '39,2' })).toContain('decimal-precision');
    expect(errors('oracle', { type: 'NUMBER', length: '39' })).toContain('decimal-precision');
    expect(errors('oracle', { type: 'NUMBER', length: '2,5' })).toEqual([]);
    expect(errors('postgresql', { type: 'NUMERIC', length: '10,2' })).toEqual([]);
  });
  it('MySQL: INT 표시 폭 255 초과는 실패', () => {
    expect(errors('mysql', { type: 'INT', length: '300' })).toContain('integer-display-width');
    expect(errors('mysql', { type: 'INT', length: '11' })).toEqual([]);
  });
  it('숫자 타입에 숫자가 아닌 기본값은 주의, PostgreSQL BOOLEAN 0/1은 실패', () => {
    expect(codes('mysql', { type: 'INT', defaultValue: "'abc'" })).toContain('warning:default-not-number');
    expect(codes('mysql', { type: 'INT', defaultValue: "'0'" })).toEqual([]);
    expect(errors('postgresql', { type: 'BOOLEAN', defaultValue: '1' })).toContain('default-boolean');
  });
  it('MySQL: TEXT·JSON에 값 그대로의 기본값은 실패, 괄호 식은 통과 (MariaDB는 허용)', () => {
    expect(errors('mysql', { type: 'TEXT', defaultValue: "'x'" })).toContain('default-on-lob');
    expect(errors('mysql', { type: 'TEXT', defaultValue: "('x')" })).toEqual([]);
    expect(errors('mariadb', { type: 'TEXT', defaultValue: "'x'" })).toEqual([]);
  });
});

describe('편집할 때 자동 보정', () => {
  it('VARCHAR(255)를 DATETIME으로 바꾸면 길이를 지운다 (MySQL)', () => {
    const { patch, notes } = autoFixColumnPatch('mysql', col({ type: 'VARCHAR', length: '255' }), { type: 'DATETIME' });
    expect(patch).toEqual({ type: 'DATETIME', length: '' });
    expect(notes).toHaveLength(1);
  });
  it('Oracle·SQL Server에서도 쓰지 않게 된 길이를 지운다', () => {
    expect(autoFixColumnPatch('oracle', col({ type: 'VARCHAR2', length: '255' }), { type: 'DATE' }).patch).toEqual({ type: 'DATE', length: '' });
    expect(autoFixColumnPatch('mssql', col({ type: 'NVARCHAR', length: '255' }), { type: 'INT' }).patch).toEqual({ type: 'INT', length: '' });
  });
  it('정수가 아닌 타입으로 바꾸면 자동 증가를 끈다', () => {
    const { patch } = autoFixColumnPatch('postgresql', col({ type: 'BIGINT', autoIncrement: true }), { type: 'VARCHAR' });
    expect(patch.autoIncrement).toBe(false);
  });
  it('INT를 VARCHAR로 바꾸면 MySQL은 길이 255를 넣는다', () => {
    expect(autoFixColumnPatch('mysql', col({ type: 'INT' }), { type: 'VARCHAR' }).patch).toEqual({ type: 'VARCHAR', length: '255' });
  });
  it('날짜 자릿수를 바꾸면 ON UPDATE 자릿수도 따라간다', () => {
    const { patch } = autoFixColumnPatch('mysql', col({ type: 'DATETIME', onUpdate: 'CURRENT_TIMESTAMP' }), { length: '3' });
    expect(patch).toEqual({ length: '3', onUpdate: 'CURRENT_TIMESTAMP(3)' });
  });
  it('날짜가 아닌 타입으로 바꾸면 ON UPDATE를 끈다', () => {
    const { patch } = autoFixColumnPatch('mysql', col({ type: 'DATETIME', onUpdate: 'CURRENT_TIMESTAMP' }), { type: 'VARCHAR' });
    expect(patch).toMatchObject({ type: 'VARCHAR', onUpdate: undefined, length: '255' });
    expect('onUpdate' in patch).toBe(true);
  });
  it('사용자가 직접 넣은 값은 바꾸지 않는다 (빨간 표시만)', () => {
    expect(autoFixColumnPatch('mysql', col({ type: 'DATETIME' }), { length: '255' }).patch).toEqual({ length: '255' });
  });
  it('canAutoIncrement', () => {
    expect(canAutoIncrement('mysql', col({ type: 'VARCHAR' }))).toBe(false);
    expect(canAutoIncrement('oracle', col({ type: 'BIGINT' }))).toBe(true);
  });
});

describe('설계 검사·DB 내보내기에 함께 나온다', () => {
  const design = () =>
    applyCommands(emptySchema(), [
      { op: 'createTable', name: 'test_table', columns: [
        { name: 'id', type: 'VARCHAR', length: '255', primaryKey: true, autoIncrement: true },
        { name: 'created_at', type: 'DATETIME', length: '255', nullable: true },
      ] },
    ]).schema;
  it('설계 검사', () => {
    const issues = lintSchema(design(), 'mysql').filter((i) => i.rule === 'type-error');
    expect(issues.map((i) => i.message)).toEqual(expect.arrayContaining([expect.stringContaining('test_table.id'), expect.stringContaining('test_table.created_at')]));
    expect(issues[0]!.fix?.kind).toBe('patchColumn');
  });
  it('DB 내보내기: 테이블 생성에 "실패 예상"', () => {
    const diff = diffSchemas(emptySchema(), design(), getDialect('mysql'));
    expect(diff.changes.find((c) => c.kind === 'createTable')!.warning).toContain('실패 예상');
  });
});
