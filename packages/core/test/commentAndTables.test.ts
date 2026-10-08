import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  addMissingTerms,
  applyCommands,
  checkTableAgainstDictionary,
  diffIncoming,
  emptySchema,
  generateStatements,
  diffSchemas,
  getDialect,
  lintSchema,
  readDictionary,
  setDictEntry,
  syncDictionaryForAi,
  updateTable,
  writeDictionary,
  type Dictionary,
} from '../src';
import { dictionaryWorkbook, parseDictionaryWorkbook } from '../src/export/dictionaryExcel';

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
    const diff = diffIncoming(schema, db, getDialect('mysql'));
    const change = diff.changes.find((c) => c.kind === 'alterColumn');
    expect(change && change.kind === 'alterColumn' && change.after.comment).toBe('내부 일련번호, 외부 노출 금지');
    expect(change && change.kind === 'alterColumn' && change.after.logicalName).toBe('회원 번호');
  });
});

describe('테이블 용어 · 같은 이름 테이블 막기', () => {
  const dict: Dictionary = {
    terms: [
      { kind: 'table', logical: '회원', physical: 'member' },
      { logical: '회원번호', physical: 'member_no', type: 'VARCHAR', length: '20' },
    ],
  };

  it('같은 이름·같은 논리명의 테이블은 만들거나 바꿀 수 없다', () => {
    const { schema } = applyCommands(emptySchema(), [
      { op: 'createTable', name: 'member', logicalName: '회원' },
      { op: 'createTable', name: 'orders', logicalName: '주문' },
    ]);
    expect(() => applyCommands(schema, [{ op: 'createTable', name: 'member2', logicalName: '회 원' }])).toThrow(/이미 member 테이블/);
    const orders = schema.tables[1];
    expect(() => updateTable(schema, orders.id, { name: 'MEMBER' })).toThrow(/이미 있습니다/);
    expect(() => updateTable(schema, orders.id, { logicalName: '회원' })).toThrow(/이미 member 테이블/);
    updateTable(schema, orders.id, { name: 'orders', logicalName: '주문' }); // 그대로는 괜찮다
  });

  it('테이블 검사: 사전과 다른 물리명·사전에 없음·다른 표기·같은 논리명', () => {
    const { schema } = applyCommands(emptySchema(), [
      { op: 'createTable', name: 'tb_member', logicalName: '회원', columns: [{ name: 'member_no', logicalName: '회원번호', type: 'VARCHAR(20)', primaryKey: true }] },
      { op: 'createTable', name: 'orders', logicalName: '주문', columns: [{ name: 'order_no', logicalName: '주문번호', type: 'BIGINT', primaryKey: true }] },
      { op: 'createTable', name: 'OrderItem', logicalName: '주문상품', columns: [{ name: 'item_no', logicalName: '상품번호', type: 'BIGINT', primaryKey: true }] },
    ]);
    expect(checkTableAgainstDictionary(dict, schema.tables[0])).toEqual({ status: 'mismatch', physical: 'member' });
    const issues = lintSchema(schema, 'mysql', { dictionary: dict }).filter((i) => !i.columnId && i.rule.startsWith('dict-'));
    expect(issues.map((i) => [i.rule, i.tableName])).toEqual(
      expect.arrayContaining([['dict-mismatch', 'tb_member'], ['dict-unknown', 'orders'], ['dict-style', 'OrderItem']]),
    );
    expect(issues.find((i) => i.tableName === 'orders')?.fix).toEqual({ kind: 'addTerm', term: { kind: 'table', logical: '주문', physical: 'orders' } });
    expect(issues.find((i) => i.tableName === 'OrderItem')?.fix).toMatchObject({ kind: 'patchTable', patch: { name: 'order_item' } });
  });

  it('사전: 테이블·컬럼은 구분해서 겹침을 보고, 표기는 함께 맞춘다. 테이블 용어엔 타입이 없다', () => {
    const doc = new Y.Doc();
    writeDictionary(doc, { terms: dict.terms });
    setDictEntry(doc, { logical: '회원', physical: 'member' }); // 같은 이름의 컬럼 용어는 따로
    expect(() => setDictEntry(doc, { kind: 'table', logical: '회원정보', physical: 'member' })).toThrow(/테이블 물리명 member/);
    expect(() => setDictEntry(doc, { kind: 'table', logical: '회원', physical: 'member_info' })).toThrow(/테이블 논리명 "회원"/);
    expect(() => setDictEntry(doc, { kind: 'table', logical: '주문', physical: 'Orders' })).toThrow(/snake_case/);
    setDictEntry(doc, { kind: 'table', logical: '주문', physical: 'orders', type: 'BIGINT' });
    const d = readDictionary(doc)!;
    expect(d.terms.find((t) => t.logical === '주문')).toEqual({ kind: 'table', logical: '주문', physical: 'orders' });
    expect(d.terms.filter((t) => t.physical === 'member').length).toBe(2);
  });

  it('AI: 새 테이블도 사전에 자동으로 (같은 것은 한 번만)', () => {
    const { schema } = applyCommands(emptySchema(), [
      { op: 'createTable', name: 'orders', logicalName: '주문', columns: [{ name: 'order_no', logicalName: '주문번호', type: 'BIGINT', primaryKey: true }] },
      { op: 'createTable', name: 'member', logicalName: '회원' },
    ]);
    const r = syncDictionaryForAi(dict, emptySchema(), schema);
    expect(r.add.filter((t) => t.kind === 'table')).toEqual([{ kind: 'table', logical: '주문', physical: 'orders' }]);
    const doc = new Y.Doc();
    writeDictionary(doc, { terms: dict.terms });
    expect(addMissingTerms(doc, [...r.add, ...r.add]).length).toBe(2);
  });

  it('엑셀: 구분 칸으로 테이블 용어를 읽고 쓴다', async () => {
    const parsed = await parseDictionaryWorkbook(await dictionaryWorkbook(dict));
    expect(parsed.terms).toEqual(dict.terms);
  });
});
