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
  case: 'asis',
  terms: [
    { logical: '회원번호', physical: 'MBR_NO', type: 'VARCHAR', length: '20' },
    { logical: '등록일시', physical: 'REG_DT', type: 'DATETIME' },
    { logical: '비고', physical: 'RMK' },
  ],
  words: [
    { logical: '회원', physical: 'MBR' },
    { logical: '상품', physical: 'PRD' },
    { logical: '수량', physical: 'QTY' },
    { logical: '상품수', physical: 'PRDCNT' },
  ],
};

describe('표준 용어 사전', () => {
  it('용어를 찾고, 없으면 단어를 이어 붙인다 (적은 단어 수 우선)', () => {
    expect(lookupTerm(dict, '회원 번호')).toMatchObject({ physical: 'MBR_NO', type: 'VARCHAR', length: '20', source: 'term' });
    expect(lookupTerm(dict, '상품수량')).toMatchObject({ physical: 'PRD_QTY', source: 'words', parts: ['상품', '수량'] });
    expect(lookupTerm(dict, '배송지')).toBeNull();
    expect(lookupTerm({ ...dict, case: 'lower' }, '회원번호')?.physical).toBe('mbr_no');
    expect(lookupPhysical(dict, 'mbr_no')?.logical).toBe('회원번호');
  });

  it('camelCase: 용어·단어 모두 mbrNo처럼, 검사·물리명 찾기도 같은 것으로 본다', () => {
    const camel = { ...dict, case: 'camel' as const };
    expect(lookupTerm(camel, '회원번호')?.physical).toBe('mbrNo');
    expect(lookupTerm(camel, '상품수량')?.physical).toBe('prdQty');
    expect(checkColumnAgainstDictionary(camel, { name: 'mbrNo', logicalName: '회원번호', type: 'VARCHAR', length: '20' })?.status).toBe('ok');
    // camelCase로 정했으면 MBR_NO는 표기가 달라 표준대로 고치라고 알린다
    expect(checkColumnAgainstDictionary(camel, { name: 'MBR_NO', logicalName: '회원번호', type: 'VARCHAR', length: '20' })?.patch?.name).toBe('mbrNo');
    expect(lookupPhysical(camel, 'mbrNo')?.logical).toBe('회원번호');
  });

  it('컬럼 검사: 대소문자는 무시하고 물리명·타입·길이를 비교', () => {
    expect(checkColumnAgainstDictionary(dict, { name: 'mbr_no', logicalName: '회원번호', type: 'VARCHAR', length: '20' })?.status).toBe('ok');
    const r = checkColumnAgainstDictionary(dict, { name: 'member_id', logicalName: '회원번호', type: 'BIGINT', length: '' });
    expect(r?.status).toBe('mismatch');
    expect(r?.patch).toEqual({ name: 'MBR_NO', type: 'VARCHAR', length: '20' });
    // 타입이 없는 용어는 물리명만 본다
    expect(checkColumnAgainstDictionary(dict, { name: 'rmk', logicalName: '비고', type: 'TEXT', length: '' })?.status).toBe('ok');
    expect(checkColumnAgainstDictionary(dict, { name: 'x', logicalName: '모르는말', type: 'TEXT', length: '' })?.status).toBe('unknown');
    expect(checkColumnAgainstDictionary(dict, { name: 'x', logicalName: '', type: 'TEXT', length: '' })).toBeNull();
  });

  it('설계 검사: 사전이 있을 때만 규칙이 돈다', () => {
    const { schema } = applyCommands(emptySchema(), [
      { op: 'createTable', name: 'member', columns: [{ name: 'member_id', logicalName: '회원번호', type: 'BIGINT', primaryKey: true }, { name: 'reg_dt', logicalName: '등록일시', type: 'DATETIME' }, { name: 'zip', logicalName: '우편번호', type: 'VARCHAR(5)' }] },
    ]);
    const without = lintSchema(schema, 'mysql');
    expect(without.some((i) => i.rule.startsWith('dict-'))).toBe(false);
    const issues = lintSchema(schema, 'mysql', { dictionary: dict });
    const mismatch = issues.find((i) => i.rule === 'dict-mismatch');
    expect(mismatch?.columnName).toBe('member_id');
    expect(mismatch?.fix).toMatchObject({ kind: 'patchColumn', patch: { name: 'MBR_NO', type: 'VARCHAR', length: '20' } });
    expect(issues.filter((i) => i.rule === 'dict-unknown').map((i) => i.columnName)).toEqual(['zip']);
  });

  it('Y 문서에 저장: replace·merge, 비우면 null', () => {
    const doc = new Y.Doc();
    expect(readDictionary(doc)).toBeNull();
    writeDictionary(doc, { terms: dict.terms, words: dict.words });
    expect(readDictionary(doc)?.terms).toHaveLength(3);
    writeDictionary(doc, { terms: [{ logical: '회원번호', physical: 'MEMBER_NO' }, { logical: ' ', physical: 'X' }] }, 'merge');
    const d = readDictionary(doc)!;
    expect(d.terms).toHaveLength(3);
    expect(d.terms.find((t) => t.logical === '회원번호')?.physical).toBe('MEMBER_NO');
    expect(d.words).toHaveLength(4);
    writeDictionary(doc, { terms: [{ logical: '비고', physical: 'RMK' }] }, 'replace');
    expect(readDictionary(doc)?.terms).toHaveLength(1);
    expect(readDictionary(doc)?.words).toHaveLength(4);
  });

  it('엑셀: 양식을 다시 읽으면 같은 내용, 회사 양식 머리글도 찾는다', async () => {
    const buf = await dictionaryWorkbook(dict);
    const parsed = await parseDictionaryWorkbook(buf);
    expect(parsed.terms).toEqual(dict.terms);
    expect(parsed.words).toEqual(dict.words);

    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sheet1');
    ws.addRow(['표준 용어 목록']);
    ws.addRow(['번호', '용어명', '영문명', '영문약어명', '도메인', '데이터타입', '설명']);
    ws.addRow([1, '회원번호', 'Member Number', 'MBR_NO', '번호V20', 'VARCHAR(20)', '']);
    const company = await parseDictionaryWorkbook((await wb.xlsx.writeBuffer()) as ArrayBuffer);
    expect(company.terms).toEqual([{ logical: '회원번호', physical: 'MBR_NO', type: 'VARCHAR', length: '20' }]);
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
    const buf = await dictionaryWorkbook({ terms, words: [], case: 'asis' }, { conflicts });
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
