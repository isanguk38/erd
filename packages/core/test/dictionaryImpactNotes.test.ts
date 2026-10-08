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
  dictionaryStyle,
  suggestTerms,
  setDictEntry,
  syncDictionaryForAi,
  addMissingTerms,
  readNotes,
  readSchema,
  removeNote,
  tableDeleteImpact,
  typeMismatches,
  updateNote,
  writeDictionary,
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
    expect(dictionaryStyle(dict)).toBe('snake');
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
    const style = issues.find((i) => i.rule === 'dict-style');
    expect(style?.columnName).toBe('memberAge');
    expect(style?.fix).toMatchObject({ kind: 'patchColumn', patch: { name: 'member_age' } });
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
    setDictEntry(doc, { logical: '회원나이', physical: 'mbr_age', type: 'SMALLINT' }, '회원나이');
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
    expect(r.notes.join('\n')).toContain('orderAmt: 사전 표기(snake_case)와 다릅니다 — order_amt');
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

describe('ERD에서 사전 만들기', () => {
  it('논리명별로 가장 많이 쓰는 이름·타입을 용어로, 다르게 쓴 곳은 충돌로', async () => {
    const { schema } = applyCommands(emptySchema(), [
      { op: 'createTable', name: 'member', columns: [{ name: 'member_id', logicalName: '회원번호', type: 'BIGINT', primaryKey: true, comment: '회원 구분' }, { name: 'nick', type: 'VARCHAR(20)' }] },
      { op: 'createTable', name: 'orders', columns: [{ name: 'member_id', logicalName: '회원 번호', type: 'BIGINT' }, { name: 'reg_dt', logicalName: '등록일시', type: 'DATETIME' }] },
      { op: 'createTable', name: 'point', columns: [{ name: 'mbr_no', logicalName: '회원번호', type: 'VARCHAR(20)' }] },
    ]);
    const { terms, conflicts, skipped } = dictionaryFromSchema(schema);
    expect(skipped).toBe(1);
    expect(terms).toEqual([
      { logical: '등록일시', physical: 'reg_dt', type: 'DATETIME' },
      { logical: '회원번호', physical: 'member_id', type: 'BIGINT', description: '회원 구분' },
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].variants.map((v) => [v.physical, v.columns.length])).toEqual([['member_id', 2], ['mbr_no', 1]]);
    // 검토용 엑셀: 충돌 시트는 다시 올릴 때 읽지 않는다
    const buf = await dictionaryWorkbook({ terms }, { conflicts });
    const parsed = await parseDictionaryWorkbook(buf);
    expect(parsed.terms).toEqual(terms);
    expect(parsed.notes.join()).not.toContain('충돌');
  });
});

describe('영향도 분석', () => {
  const { schema } = applyCommands(emptySchema(), [
    { op: 'createTable', name: 'member', columns: [{ name: 'id', type: 'BIGINT', primaryKey: true }, { name: 'email', type: 'VARCHAR(100)' }, { name: 'point', type: 'INT' }] },
    { op: 'createTable', name: 'orders', columns: [{ name: 'id', type: 'BIGINT', primaryKey: true }] },
    { op: 'createTable', name: 'review', columns: [{ name: 'id', type: 'BIGINT', primaryKey: true }] },
    { op: 'addRelation', parent: 'member', child: 'orders' },
    { op: 'addRelation', parent: 'orders', child: 'review', identifying: true },
    { op: 'addIndex', table: 'member', columns: ['email', 'point'] },
    { op: 'addCheck', table: 'member', expression: 'point >= 0' },
    { op: 'createArea', name: '회원', tables: ['member'] },
  ]);
  const member = schema.tables.find((t) => t.name === 'member')!;
  const col = (n: string) => member.columns.find((c) => c.name === n)!.id;

  it('컬럼 삭제: 다른 테이블 외래키, 인덱스 축소, CHECK', () => {
    const pk = columnDeleteImpact(schema, member.id, col('id'));
    expect(pk.filter((i) => i.external).map((i) => i.text)[0]).toContain('orders(member_id) → member.id');
    const point = columnDeleteImpact(schema, member.id, col('point'));
    expect(point.map((i) => i.kind).sort()).toEqual(['check', 'index']);
    expect(point.find((i) => i.kind === 'index')?.text).toContain('→ (email)');
  });

  it('테이블 삭제: 자식 외래키와 영역', () => {
    const items = tableDeleteImpact(schema, member.id);
    expect(items.filter((i) => i.external)).toHaveLength(1);
    expect(items.some((i) => i.kind === 'area' && i.text.includes('회원'))).toBe(true);
  });

  it('타입 변경: FK로 이어진 컬럼(손자까지)을 찾아 맞춘다', () => {
    const s = structuredClone(schema);
    const m = s.tables.find((t) => t.name === 'member')!;
    m.columns.find((c) => c.name === 'id')!.type = 'VARCHAR';
    m.columns.find((c) => c.name === 'id')!.length = '20';
    // orders.id → review.orders_id 는 member.id와 이어지지 않는다 (다른 컬럼)
    expect(typeMismatches(s, m.id, col('id')).map((l) => `${l.table}.${l.column}`)).toEqual(['orders.member_id']);
    expect(changeImpact(schema, s)[0]).toContain('orders.member_id(BIGINT)');
    expect(propagateColumnType(s, m.id, col('id'))).toEqual(['orders.member_id']);
    expect(typeMismatches(s, m.id, col('id'))).toEqual([]);
    expect(lintSchema(s, 'mysql').some((i) => i.rule === 'fk-type-mismatch')).toBe(false);
  });

  it('AI 편집 결과: 지운 PK 컬럼 때문에 사라진 외래키를 알린다', () => {
    const { schema: after } = applyCommands(schema, [{ op: 'dropColumn', table: 'member', column: 'id' }]);
    expect(changeImpact(schema, after).join('\n')).toContain('member.id 삭제');
  });
});

describe('캔버스 메모', () => {
  it('스키마와 따로 저장되고, 탭별로 나뉘고, 지운 영역의 메모는 숨긴다', () => {
    const doc = new Y.Doc();
    const { schema } = applyCommands(emptySchema(), [{ op: 'createTable', name: 'a' }, { op: 'createArea', name: '회원', tables: ['a'] }]);
    writeSchema(doc, schema);
    const areaId = schema.areas![0].id;
    const all = addNote(doc, { text: '전체 메모', position: { x: 10.4, y: 20 } });
    const inArea = addNote(doc, { text: '영역 메모', position: { x: 0, y: 0 }, areaId });
    expect(readSchema(doc)).toEqual(readSchema(doc)); // 스키마에는 notes가 없다
    expect('notes' in readSchema(doc)).toBe(false);
    expect(notesOf(readNotes(doc), null).map((n) => n.id)).toEqual([all]);
    expect(notesOf(readNotes(doc), areaId).map((n) => n.id)).toEqual([inArea]);
    expect(readNotes(doc).find((n) => n.id === all)?.position).toEqual({ x: 10, y: 20 });
    updateNote(doc, all, { text: '고침', width: 10, color: '#dbeafe' });
    expect(readNotes(doc).find((n) => n.id === all)).toMatchObject({ text: '고침', width: 120, color: '#dbeafe' });
    writeSchema(doc, { ...readSchema(doc), areas: [] });
    expect(readNotes(doc).map((n) => n.id)).toEqual([all]);
    removeNote(doc, all);
    expect(readNotes(doc)).toEqual([]);
  });
});
