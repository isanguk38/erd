import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  applyCommands,
  detectNamingStyles,
  describeNaming,
  fitsStyle,
  readMeta,
  writeMeta,
  diffIncoming,
  diffSchemas,
  emptySchema,
  generateStatements,
  getDialect,
  lintSchema,
  namingIssues,
  namingNotes,
  projectNamingStyles,
  toStyle,
  updateTable,
} from '../src';

describe('DB comment = 논리명, 설명 = ERD 전용', () => {
  const { schema } = applyCommands(emptySchema(), [
    { op: 'createTable', name: 'member', logicalName: '회원', comment: '가입한 회원 (탈퇴 포함)', columns: [{ name: 'id', logicalName: '회원번호', type: 'BIGINT', primaryKey: true, comment: '내부 일련번호, 외부 노출 금지' }] },
  ]);

  it('SQL에는 논리명만 comment로 들어가고 설명은 들어가지 않는다', () => {
    for (const d of ['mysql', 'postgresql', 'oracle', 'mssql'] as const) {
      const sql = generateStatements(diffSchemas(emptySchema(), schema, getDialect(d)), getDialect(d)).map((s) => s.sql).join('\n');
      expect(sql, d).toContain('회원번호');
      expect(sql, d).not.toContain('외부 노출');
      expect(sql, d).not.toContain('탈퇴 포함');
    }
  });

  it('설명만 바꾸면 DB에 낼 변경이 없다', () => {
    const next = structuredClone(schema);
    next.tables[0].comment = '바뀐 설명';
    next.tables[0].columns[0].comment = '바뀐 컬럼 설명';
    expect(diffSchemas(schema, next, getDialect('mysql')).changes).toEqual([]);
  });

  it('DB에서 가져와도 ERD의 설명은 남는다 (DB comment는 논리명으로)', () => {
    const db = structuredClone(schema);
    db.tables[0].comment = '';
    db.tables[0].columns[0].comment = '';
    db.tables[0].columns[0].logicalName = '회원 번호';
    const change = diffIncoming(schema, db, getDialect('mysql')).changes.find((c) => c.kind === 'alterColumn');
    expect(change && change.kind === 'alterColumn' && change.after.comment).toBe('내부 일련번호, 외부 노출 금지');
    expect(change && change.kind === 'alterColumn' && change.after.logicalName).toBe('회원 번호');
  });
});

describe('같은 이름·같은 논리명 테이블 막기', () => {
  it('만들거나 바꿀 때 막고, 원래 겹친 것은 설계 검사가 알린다', () => {
    const { schema } = applyCommands(emptySchema(), [
      { op: 'createTable', name: 'member', logicalName: '회원' },
      { op: 'createTable', name: 'orders', logicalName: '주문' },
    ]);
    expect(() => applyCommands(schema, [{ op: 'createTable', name: 'member2', logicalName: '회 원' }])).toThrow(/이미 member 테이블/);
    const orders = schema.tables[1];
    expect(() => updateTable(schema, orders.id, { name: 'MEMBER' })).toThrow(/이미 있습니다/);
    expect(() => updateTable(schema, orders.id, { logicalName: '회원' })).toThrow(/이미 member 테이블/);
    updateTable(schema, orders.id, { name: 'orders', logicalName: '주문' }); // 그대로는 괜찮다
    schema.tables[1].logicalName = '회원'; // (예전에 겹쳐 들어간 경우)
    expect(lintSchema(schema, 'mysql').filter((i) => i.rule === 'duplicate-table-logical').map((i) => i.tableName)).toEqual(['orders']);
  });
});

describe('이름 표기 기준', () => {
  const { schema } = applyCommands(emptySchema(), [
    { op: 'createTable', name: 'member', columns: [{ name: 'member_id', type: 'BIGINT', primaryKey: true }, { name: 'nick_name', type: 'VARCHAR(20)' }, { name: 'memberAge', type: 'INT' }] },
    { op: 'createTable', name: 'OrderItem', columns: [{ name: 'order_item_id', type: 'BIGINT', primaryKey: true }, { name: '비고', type: 'TEXT' }] },
  ]);

  it('표기 바꾸기·판단 (한 단어는 snake·camel 둘 다 맞음, 많이 맞는 쪽)', () => {
    expect(toStyle('memberAge', 'snake')).toBe('member_age');
    expect(toStyle('MEMBER_AGE', 'camel')).toBe('memberAge');
    expect(toStyle('member_age', 'SNAKE')).toBe('MEMBER_AGE');
    // 앞 밑줄(도구가 만든 테이블)은 그대로 두고 본다
    expect(fitsStyle('_prisma_migrations', 'snake')).toBe(true);
    expect(fitsStyle('__EFMigrationsHistory', 'snake')).toBe(false);
    expect(toStyle('_orderItem', 'snake')).toBe('_order_item');
    const tool = applyCommands(emptySchema(), [{ op: 'createTable', name: '__EFMigrationsHistory', columns: [{ name: 'MigrationId', type: 'VARCHAR(150)', primaryKey: true }] }, { op: 'createTable', name: '_prisma_migrations', columns: [{ name: 'id', type: 'VARCHAR(36)', primaryKey: true }] }]).schema;
    expect(namingIssues(tool, 'snake')).toEqual([]);
    expect(detectNamingStyles(schema)).toEqual({ table: 'snake', column: 'snake' });
    expect(detectNamingStyles(emptySchema())).toEqual({ table: null, column: null });
    // 예전 값(문자열 하나)은 테이블·컬럼 모두
    expect(projectNamingStyles('camel', schema).table).toEqual({ style: 'camel', auto: false, from: 'saved' });
    expect(projectNamingStyles(null, schema).column).toEqual({ style: 'snake', auto: true, from: 'names' });
    // 한쪽만 정하면 다른 쪽은 판단
    expect(projectNamingStyles({ table: 'camel', column: null }, schema)).toEqual({ table: { style: 'camel', auto: false, from: 'saved' }, column: { style: 'snake', auto: true, from: 'names' } });
  });

  it('기준과 다른 테이블·컬럼 (바꿀 이름이 없으면 고치기 없이)', () => {
    expect(namingIssues(schema, 'snake').map((i) => [i.column ?? i.table, i.suggestion])).toEqual([
      ['memberAge', 'member_age'],
      ['OrderItem', 'order_item'],
      ['비고', undefined],
    ]);
  });

  it('설계 검사: 저장한 기준(없으면 판단한 기준)으로, 고치기 버튼 포함', () => {
    const auto = lintSchema(schema, 'mysql').filter((i) => i.rule === 'naming-mixed');
    expect(auto.map((i) => i.message)).toEqual(expect.arrayContaining([expect.stringContaining('이 프로젝트는 snake_case 기준입니다 — member_age')]));
    expect(auto.find((i) => i.tableName === 'OrderItem' && !i.columnId)?.fix).toMatchObject({ kind: 'patchTable', patch: { name: 'order_item' } });
    const camel = lintSchema(schema, 'mysql', { namingStyle: 'camel' }).filter((i) => i.rule === 'naming-mixed');
    expect(camel.find((i) => i.columnName === 'member_id')?.fix).toMatchObject({ kind: 'patchColumn', patch: { name: 'memberId' } });
  });

  it('테이블·컬럼 따로: 테이블 camelCase + 컬럼 snake_case', () => {
    const mixed = applyCommands(emptySchema(), [
      { op: 'createTable', name: 'orderItem', columns: [{ name: 'order_item_id', type: 'BIGINT', primaryKey: true }, { name: 'itemName', type: 'VARCHAR(20)' }] },
      { op: 'createTable', name: 'member_info', columns: [{ name: 'member_id', type: 'BIGINT', primaryKey: true }] },
    ]).schema;
    const setting = { table: 'camel' as const, column: 'snake' as const };
    const issues = lintSchema(mixed, 'mysql', { namingStyle: setting }).filter((i) => i.rule === 'naming-mixed');
    expect(issues.map((i) => [i.columnName ?? i.tableName, i.message.split(': ')[1]])).toEqual([
      ['member_info', '이 프로젝트는 테이블 이름 camelCase 기준입니다 — memberInfo(으)로 바꾸세요'],
      ['itemName', '이 프로젝트는 컬럼 이름 snake_case 기준입니다 — item_name(으)로 바꾸세요'],
    ]);
    // 기준을 안 정하면 테이블 이름끼리·컬럼 이름끼리 따로 판단한다
    expect(detectNamingStyles(applyCommands(emptySchema(), [{ op: 'createTable', name: 'orderItem', columns: [{ name: 'order_id', type: 'BIGINT' }, { name: 'item_name', type: 'INT' }] }, { op: 'createTable', name: 'memberInfo' }]).schema)).toEqual({ table: 'camel', column: 'snake' });
    expect(describeNaming(setting)).toBe('테이블 camelCase · 컬럼 snake_case');
    expect(describeNaming({ table: 'snake', column: 'snake' })).toBe('snake_case');
    // 저장: 같으면 문자열 하나, 다르면 따로
    const doc = new Y.Doc();
    writeMeta(doc, { namingStyle: setting });
    expect(readMeta(doc).namingStyle).toEqual(setting);
    writeMeta(doc, { namingStyle: { table: 'snake', column: 'snake' } });
    expect(readMeta(doc).namingStyle).toEqual({ table: 'snake', column: 'snake' });
    writeMeta(doc, { namingStyle: null });
    expect(readMeta(doc).namingStyle).toBeNull();
  });

  it('AI 편집 결과: 이번에 만들거나 바꾼 이름만 알린다', () => {
    const { schema: after } = applyCommands(schema, [{ op: 'addColumn', table: 'member', column: { name: 'joinDate', type: 'DATE' } }]);
    const notes = namingNotes(schema, after, 'snake');
    expect(notes).toEqual(['member.joinDate: 이 프로젝트는 snake_case 기준입니다 — join_date(으)로 바꾸세요']);
    expect(namingNotes(schema, after, null)).toEqual([]);
  });
});
