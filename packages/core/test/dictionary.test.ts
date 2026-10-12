// 표준 용어 사전 (이름 표기는 프로젝트 기준을 따른다)
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  addNote,
  applyCommands,
  changeImpact,
  checkColumnAgainstDictionary,
  columnDeleteImpact,
  dictionaryFromSchema,
  emptySchema,
  lintSchema,
  lookupPhysical,
  lookupTerm,
  notesOf,
  propagateColumnType,
  readDictionary,
  clearDictionary,
  detectStyle,
  toStyle,
  dictionaryStyles,
  dictIndex,
  projectNamingStyles,
  suggestTerms,
  setDictEntry,
  syncDictionaryForAi,
  addMissingTerms,
  logicalFillsFromSchema,
  removeDictEntry,
  readNotes,
  readSchema,
  removeNote,
  tableDeleteImpact,
  typeMismatches,
  updateNote,
  writeDictionary,
  writeMeta,
  writeSchema,
  type Dictionary,
} from '../src';
import { dictionaryWorkbook, parseDictionaryWorkbook } from '../src/export/dictionaryExcel';

const dict: Dictionary = {
  terms: [
    { logical: '회원번호', physical: 'mbr_no', type: 'VARCHAR', length: '20' },
    { logical: '등록일시', physical: 'reg_dt', type: 'DATETIME' },
    { logical: '비고', physical: 'rmk' },
    { logical: '회원메모', physical: 'memory_id', type: 'BIGINT' },
  ],
};

describe('표준 용어 사전', () => {
  it('용어를 찾는다 (띄어쓰기 무시). 사전에 없으면 만들지 않는다', () => {
    expect(lookupTerm(dict, '회원 번호')).toEqual({ physical: 'mbr_no', type: 'VARCHAR', length: '20' });
    expect(lookupTerm(dict, '회원등록일시')).toBeNull();
    expect(lookupPhysical(dict, 'MBR_NO')?.logical).toBe('회원번호');
  });

  it('표기 판단: 가장 많이 맞는 표기, 한 단어는 어느 쪽에도 맞음, 다른 표기는 섞인 것', () => {
    expect(detectStyle(dict.terms)).toEqual({ style: 'snake', offenders: [] });
    expect(detectStyle([{ logical: 'a', physical: 'MBR_NO' }, { logical: 'b', physical: 'PRICE' }]).style).toBe('SNAKE');
    expect(detectStyle([{ logical: 'a', physical: 'mbrNo' }, { logical: 'b', physical: 'price' }]).style).toBe('camel');
    const mixed = detectStyle([...dict.terms, { logical: '회원나이', physical: 'mbrAge' }]);
    expect(mixed.style).toBe('snake');
    expect(mixed.offenders.map((t) => t.physical)).toEqual(['mbrAge']);
    expect(toStyle('memberAge', 'snake')).toBe('member_age');
    expect(toStyle('member_age', 'camel')).toBe('memberAge');
    expect(dictionaryStyles(dict)).toEqual({ table: null, column: 'snake' });
  });

  it('입력 중 후보: 앞부분이 맞는 것 먼저, 물리명·논리명 양쪽', () => {
    expect(suggestTerms(dict, 'm', 'physical').map((t) => t.physical)).toEqual(['mbr_no', 'memory_id', 'rmk']);
    expect(suggestTerms(dict, 'mem', 'physical').map((t) => t.physical)).toEqual(['memory_id']);
    expect(suggestTerms(dict, '회원', 'logical').map((t) => t.logical)).toEqual(['회원번호', '회원메모']);
    expect(suggestTerms(dict, 'mbr_no', 'physical')).toEqual([]);
  });

  it('컬럼 검사: 물리명은 사전에 적힌 그대로, 타입·길이도 비교', () => {
    expect(checkColumnAgainstDictionary(dict, { name: 'mbr_no', logicalName: '회원번호', type: 'VARCHAR', length: '20' })?.status).toBe('ok');
    const r = checkColumnAgainstDictionary(dict, { name: 'member_id', logicalName: '회원번호', type: 'BIGINT', length: '' });
    expect(r?.patch).toEqual({ name: 'mbr_no', type: 'VARCHAR', length: '20' });
    expect(checkColumnAgainstDictionary(dict, { name: 'MBR_NO', logicalName: '회원번호', type: 'VARCHAR', length: '20' })?.status).toBe('mismatch');
    expect(checkColumnAgainstDictionary(dict, { name: 'rmk', logicalName: '비고', type: 'TEXT', length: '' })?.status).toBe('ok');
    expect(checkColumnAgainstDictionary(dict, { name: 'x', logicalName: '모르는말', type: 'TEXT', length: '' })?.status).toBe('unknown');
  });

  it('설계 검사: 사전에 없는 용어는 경고 + 사전에 추가, 사전과 다른 표기는 경고 + 바꾸기', () => {
    const { schema } = applyCommands(emptySchema(), [
      { op: 'createTable', name: 'member', columns: [
        { name: 'member_id', logicalName: '회원번호', type: 'BIGINT', primaryKey: true },
        { name: 'zip_cd', logicalName: '우편번호', type: 'VARCHAR(5)' },
        { name: 'memberAge', logicalName: '회원나이', type: 'INT' },
        { name: 'mbr_no', logicalName: '회원고유번호', type: 'VARCHAR(20)' },
      ] },
    ]);
    expect(lintSchema(schema, 'mysql').some((i) => i.rule.startsWith('dict-'))).toBe(false);
    const issues = lintSchema(schema, 'mysql', { dictionary: dict });
    expect(issues.find((i) => i.rule === 'dict-mismatch')?.columnName).toBe('member_id');
    const unknown = issues.filter((i) => i.rule === 'dict-unknown');
    expect(unknown.every((i) => i.severity === 'warning')).toBe(true);
    expect(unknown.find((i) => i.columnName === 'zip_cd')?.fix).toEqual({ kind: 'addTerm', term: { logical: '우편번호', physical: 'zip_cd', type: 'VARCHAR', length: '5' } });
    // 물리명이 이미 다른 논리명으로 사전에 있으면 사전에 추가하지 않고 논리명을 맞추라고
    expect(unknown.find((i) => i.columnName === 'mbr_no')?.fix).toMatchObject({ kind: 'patchColumn', patch: { logicalName: '회원번호' } });
    // 표기는 이름 표기 기준 경고 하나로만 (사전의 표기를 프로젝트 기준으로 본다)
    const style = issues.filter((i) => i.rule === 'naming-mixed');
    expect(style.map((i) => i.columnName)).toEqual(['memberAge']);
    expect(style[0].message).toContain('snake_case 기준');
    expect(style[0].fix).toMatchObject({ kind: 'patchColumn', patch: { name: 'member_age' } });
    expect(unknown.some((i) => i.columnName === 'memberAge')).toBe(false);
  });

  it('프로젝트 이름 표기 기준: 저장한 기준이 있으면 사전도 그 표기만, 없으면 사전 표기가 프로젝트 기준', () => {
    const doc = new Y.Doc();
    writeDictionary(doc, { terms: dict.terms });
    expect(projectNamingStyles(undefined, { tables: [] }, dictIndex(readDictionary(doc)!).styles).column).toEqual({ style: 'snake', auto: true, from: 'dictionary' });
    writeMeta(doc, { namingStyle: { table: 'camel', column: 'camel' } });
    expect(readDictionary(doc)?.namingStyle).toEqual({ table: 'camel', column: 'camel' });
    expect(() => setDictEntry(doc, { logical: '회원나이', physical: 'member_age' })).toThrow(/컬럼 이름 표기 기준은 camelCase/);
    expect(() => writeDictionary(doc, { terms: [{ logical: '나이', physical: 'age_cnt' }] }, 'merge')).toThrow(/이름 표기 기준은 camelCase/);
    writeMeta(doc, { namingStyle: { table: 'snake', column: 'snake' } });
    setDictEntry(doc, { logical: '회원나이', physical: 'member_age' });
    expect(lookupTerm(readDictionary(doc), '회원나이')?.physical).toBe('member_age');
    // 테이블 camelCase · 컬럼 snake_case: 테이블 용어와 컬럼 용어를 따로 본다
    writeMeta(doc, { namingStyle: { table: 'camel', column: 'snake' } });
    setDictEntry(doc, { kind: 'table', logical: '주문상품', physical: 'orderItem' });
    expect(() => setDictEntry(doc, { kind: 'table', logical: '회원정보', physical: 'member_info' })).toThrow(/테이블 이름 표기 기준은 camelCase/);
    expect(dictIndex(readDictionary(doc)!).styles).toEqual({ table: 'camel', column: 'snake' });
    // 기준 없이도 테이블 용어·컬럼 용어가 각자 한 표기면 넣을 수 있다
    const free = new Y.Doc();
    writeDictionary(free, { terms: [{ kind: 'table', logical: '주문', physical: 'orderMain' }, { logical: '주문번호', physical: 'order_no' }] });
    expect(dictIndex(readDictionary(free)!).styles).toEqual({ table: 'camel', column: 'snake' });
  });

  it('문서에 넣기: 표기가 섞이면 넣지 않고, 같은 물리명·다른 표기 용어는 하나씩 추가도 막는다', () => {
    const doc = new Y.Doc();
    expect(readDictionary(doc)).toBeNull();
    expect(() => writeDictionary(doc, { terms: [...dict.terms, { logical: '회원나이', physical: 'mbrAge' }] })).toThrow(/섞여/);
    expect(readDictionary(doc)).toBeNull();
    writeDictionary(doc, { terms: dict.terms });
    expect(readDictionary(doc)?.terms).toHaveLength(4);
    // 합치기에서도 기존 용어와 섞이면 막는다
    expect(() => writeDictionary(doc, { terms: [{ logical: '회원나이', physical: 'MBR_AGE' }] }, 'merge')).toThrow(/섞여/);
    expect(() => setDictEntry(doc, { logical: '회원나이', physical: 'mbrAge' })).toThrow(/snake_case.*mbr_age/);
    expect(() => setDictEntry(doc, { logical: '회원고유번호', physical: 'mbr_no' })).toThrow(/이미 "회원번호"/);
    setDictEntry(doc, { logical: '회원나이', physical: 'mbr_age', type: 'INT' });
    // 자기 자신을 고칠 때는 같은 물리명이어도 된다
    setDictEntry(doc, { logical: '회원나이', physical: 'mbr_age', type: 'SMALLINT' }, { logical: '회원나이', physical: 'mbr_age' });
    expect(readDictionary(doc)?.terms.find((t) => t.logical === '회원나이')?.type).toBe('SMALLINT');
    clearDictionary(doc);
    expect(readDictionary(doc)).toBeNull();
  });

  it('AI가 만든 컬럼: 사전에 없는 용어는 넣고 (같은 논리명·물리명은 한 번만), 다른 표기·이미 있는 물리명은 넣지 않고 안내', () => {
    const before = emptySchema();
    const { schema: after } = applyCommands(before, [
      { op: 'createTable', name: 'orders', columns: [
        { name: 'order_no', logicalName: '주문번호', type: 'VARCHAR(20)', primaryKey: true },
        { name: 'mbr_no', logicalName: '회원번호', type: 'VARCHAR(20)' },
        { name: 'orderAmt', logicalName: '주문금액', type: 'DECIMAL(12,2)' },
        { name: 'memory_id', logicalName: '메모번호', type: 'BIGINT' },
      ] },
      { op: 'createTable', name: 'order_item', columns: [{ name: 'order_no', logicalName: '주문번호', type: 'VARCHAR(20)' }] },
    ]);
    const r = syncDictionaryForAi(dict, before, after);
    expect(r.add).toEqual([{ logical: '주문번호', physical: 'order_no', type: 'VARCHAR', length: '20' }]);
    expect(r.notes.join('\n')).toContain('orderAmt: 이름 표기 기준(snake_case)과 다릅니다 — order_amt');
    expect(r.notes.join('\n')).toContain('memory_id은(는) 사전에 "회원메모"');
    const doc = new Y.Doc();
    writeDictionary(doc, { terms: dict.terms });
    expect(addMissingTerms(doc, [...r.add, ...r.add, { logical: '다른이름', physical: 'order_no' }]).map((t) => t.physical)).toEqual(['order_no']);
    expect(readDictionary(doc)?.terms).toHaveLength(5);
    expect(syncDictionaryForAi(null, before, after)).toEqual({ add: [], notes: [] });
  });

  it('엑셀: 양식을 다시 읽으면 같은 내용, 회사 양식 머리글도 찾는다', async () => {
    const buf = await dictionaryWorkbook(dict);
    const parsed = await parseDictionaryWorkbook(buf);
    expect(parsed.terms).toEqual(dict.terms);

    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sheet1');
    ws.addRow(['표준 용어 목록']);
    ws.addRow(['번호', '용어명', '영문명', '영문약어명', '도메인', '데이터타입', '설명']);
    ws.addRow([1, '회원번호', 'Member Number', 'MBR_NO', '번호V20', 'VARCHAR(20)', '']);
    // 예전 양식의 표준단어 시트는 건너뛴다
    const words = wb.addWorksheet('표준단어');
    words.addRow(['단어명', '영문약어명']);
    words.addRow(['회원', 'MBR']);
    const company = await parseDictionaryWorkbook((await wb.xlsx.writeBuffer()) as ArrayBuffer);
    expect(company.terms).toEqual([{ logical: '회원번호', physical: 'MBR_NO', type: 'VARCHAR', length: '20' }]);
    expect(company.notes.join('\n')).toContain('표준 단어는 쓰지 않아 건너뜀');
  });
});

describe('ERD에서 사전 만들기 · 논리명 없는 용어', () => {
  it('도구가 만든 테이블(_prisma_migrations)은 사전 초안·설계 검사(논리명·표기)에서 뺀다', () => {
    const schema = applyCommands(emptySchema(), [
      { op: 'createTable', name: '_prisma_migrations', columns: [{ name: 'id', type: 'VARCHAR(36)', primaryKey: true }, { name: 'applied_steps_count', type: 'INT' }] },
      { op: 'createTable', name: 'orders', logicalName: '주문', columns: [{ name: 'orderId', logicalName: '주문번호', type: 'INT', primaryKey: true }] },
    ]).schema;
    const draft = dictionaryFromSchema(schema);
    expect(draft.map((r) => r.physical)).toEqual(expect.not.arrayContaining(['applied_steps_count', '_prisma_migrations']));
    expect(draft.map((r) => r.physical)).toEqual(expect.arrayContaining(['orderId', 'orders']));
    expect(lintSchema(schema, 'postgresql').filter((i) => i.tableName === '_prisma_migrations')).toEqual([]);
  });

  const { schema } = applyCommands(emptySchema(), [
    { op: 'createTable', name: 'member', columns: [{ name: 'member_id', logicalName: '회원번호', type: 'BIGINT', primaryKey: true, comment: '회원 구분' }, { name: 'nick', type: 'VARCHAR(20)' }] },
    { op: 'createTable', name: 'orders', columns: [{ name: 'member_id', logicalName: '회원 번호', type: 'BIGINT' }, { name: 'reg_dt', logicalName: '등록일시', type: 'DATETIME' }, { name: 'nick', type: 'VARCHAR(20)' }] },
    { op: 'createTable', name: 'point', columns: [{ name: 'mbr_no', logicalName: '회원번호', type: 'VARCHAR(20)' }] },
  ]);

  it('논리명별로 가장 많이 쓰는 이름·타입, 다르게 쓴 것은 variants, 논리명 없는 컬럼은 물리명으로 묶어 논리명 없이', () => {
    const all = dictionaryFromSchema(schema);
    // 테이블 용어가 먼저 (타입 없이). 논리명 없는 테이블도 물리명으로
    expect(all.filter((r) => r.kind === 'table').map((r) => [r.logical, r.physical, r.type])).toEqual([['', 'member', undefined], ['', 'orders', undefined], ['', 'point', undefined]]);
    const rows = all.filter((r) => r.kind !== 'table');
    expect(rows.map((r) => [r.logical, r.physical, r.type, r.variants.length])).toEqual([
      ['등록일시', 'reg_dt', 'DATETIME', 1],
      ['회원번호', 'member_id', 'BIGINT', 2],
      ['', 'nick', 'VARCHAR', 1],
    ]);
    expect(rows[1].description).toBe('회원 구분');
    expect(rows[1].variants.map((v) => [v.physical, v.columns.length])).toEqual([['member_id', 2], ['mbr_no', 1]]);
    expect(rows[2].variants[0].columns).toEqual(['member.nick', 'orders.nick']);
  });

  it('논리명 없는 용어: 넣을 수 있고, 같은 물리명에 논리명을 채우면 그 용어가 된다 (AI·ERD 채우기)', () => {
    const doc = new Y.Doc();
    writeDictionary(doc, { terms: [{ logical: '', physical: 'nick', type: 'VARCHAR', length: '20' }, { logical: '회원번호', physical: 'member_id' }] });
    let d = readDictionary(doc)!;
    expect(d.terms.map((t) => t.logical)).toEqual(['회원번호', '']);
    // 이 컬럼은 논리명이 사전에 없지만 물리명이 논리명 없이 있으므로 문제 아님
    expect(checkColumnAgainstDictionary(d, { name: 'nick', logicalName: '별명', type: 'VARCHAR', length: '20' })?.status).toBe('ok');
    expect(logicalFillsFromSchema(d, { tables: [{ columns: [{ ...schema.tables[0].columns[1], logicalName: '별명' }] }] })).toEqual([{ logical: '별명', physical: 'nick', type: 'VARCHAR', length: '20' }]);
    expect(addMissingTerms(doc, [{ logical: '별명', physical: 'nick', type: 'VARCHAR', length: '20' }]).length).toBe(1);
    d = readDictionary(doc)!;
    expect(d.terms.map((t) => `${t.logical}=${t.physical}`)).toEqual(['별명=nick', '회원번호=member_id']);
    // 화면에서 논리명 칸을 채우는 것도 같은 용어로
    setDictEntry(doc, { logical: '', physical: 'reg_dt' });
    setDictEntry(doc, { logical: '등록일시', physical: 'reg_dt' }, { logical: '', physical: 'reg_dt' });
    expect(readDictionary(doc)!.terms.filter((t) => t.physical === 'reg_dt').map((t) => t.logical)).toEqual(['등록일시']);
    // 엑셀로 내려받아 다시 읽어도 논리명 없는 줄이 남는다
    removeDictEntry(doc, { logical: '별명', physical: 'nick' });
    setDictEntry(doc, { logical: '', physical: 'nick' });
  });

  it('엑셀: 논리명 없는 줄도 다시 읽는다', async () => {
    const terms = [{ logical: '회원번호', physical: 'member_id' }, { logical: '', physical: 'nick' }];
    const parsed = await parseDictionaryWorkbook(await dictionaryWorkbook({ terms }));
    expect(parsed.terms).toEqual(terms);
  });
});

