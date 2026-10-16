import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { applyChanges, applyCommands, describeSchema, diffSchemas, emptySchema, getDialect, guessPrivacy, lintSchema, readSchema, writeSchema, type Schema } from '../src';
import * as Y from 'yjs';
import { buildDefinitionWorkbook } from '../src/export/definition';

const col = (name: string, logicalName = '') => ({ name, logicalName });

describe('개인정보 컬럼', () => {
  it('이름으로 종류 짐작', () => {
    expect(guessPrivacy(col('jumin_no'))).toBe('unique');
    expect(guessPrivacy(col('rrn'))).toBe('unique');
    expect(guessPrivacy(col('x', '주민등록번호'))).toBe('unique');
    expect(guessPrivacy(col('passport_no'))).toBe('unique');
    expect(guessPrivacy(col('password'))).toBe('password');
    expect(guessPrivacy(col('userPwd'))).toBe('password');
    expect(guessPrivacy(col('bank_account_no'))).toBe('financial');
    expect(guessPrivacy(col('card_no'))).toBe('financial');
    expect(guessPrivacy(col('member_name', '회원명'))).toBe('personal');
    expect(guessPrivacy(col('mobile_no'))).toBe('personal');
    expect(guessPrivacy(col('email'))).toBe('personal');
    expect(guessPrivacy(col('addr1', '주소'))).toBe('personal');
    expect(guessPrivacy(col('birth_date'))).toBe('personal');
    expect(guessPrivacy(col('health_info'))).toBe('sensitive');
    // 사람이 아닌 것
    expect(guessPrivacy(col('product_name', '상품명'))).toBeNull();
    expect(guessPrivacy(col('description', '설명'))).toBeNull();
    expect(guessPrivacy(col('hotel_id'))).toBeNull();
    expect(guessPrivacy(col('shipping_fee'))).toBeNull();
  });

  it('설계 검사: 표시 권함(참고) → 표시하면 암호화 표시 없음(경고) → 암호화 표시하면 없음', () => {
    let schema = applyCommands(emptySchema(), [
      { op: 'createTable', name: 'member', columns: [{ name: 'member_id', type: 'BIGINT', primaryKey: true }, { name: 'rrn', logicalName: '주민등록번호', type: 'VARCHAR(256)' }] },
    ]).schema;
    let issues = lintSchema(schema, 'mysql').filter((i) => i.rule.startsWith('privacy'));
    expect(issues.map((i) => [i.rule, i.severity])).toEqual([['privacy-unmarked', 'info']]);
    expect(issues[0]!.fix).toMatchObject({ kind: 'patchColumn', patch: { privacy: { kind: 'unique' } } });

    schema = applyCommands(schema, [{ op: 'updateColumn', table: 'member', column: 'rrn', changes: { privacy: 'unique' } }]).schema;
    issues = lintSchema(schema, 'mysql').filter((i) => i.rule.startsWith('privacy'));
    expect(issues.map((i) => [i.rule, i.severity])).toEqual([['privacy-unencrypted', 'warning']]);

    schema = applyCommands(schema, [{ op: 'updateColumn', table: 'member', column: 'rrn', changes: { encrypted: true } }]).schema;
    expect(lintSchema(schema, 'mysql').filter((i) => i.rule.startsWith('privacy'))).toEqual([]);
    expect(describeSchema(schema).tables[0]!.columns[1]).toMatchObject({ privacy: 'unique', encrypted: true });
    expect(() => applyCommands(schema, [{ op: 'updateColumn', table: 'member', column: 'rrn', changes: { privacy: 'secret' as never } }])).toThrow(/개인정보 종류/);
  });

  it('ERD에만 저장: Yjs 문서에 남고, DB 비교·가져오기에는 영향 없음', () => {
    const erd = applyCommands(emptySchema(), [
      { op: 'createTable', name: 'member', columns: [{ name: 'member_id', type: 'BIGINT', primaryKey: true }, { name: 'phone', type: 'VARCHAR(13)', privacy: 'personal' }] },
    ]).schema;
    const doc = new Y.Doc();
    writeSchema(doc, erd);
    expect(readSchema(doc).tables[0]!.columns[1]!.privacy).toEqual({ kind: 'personal' });

    // DB 쪽(개인정보 표시 없음)과 비교해도 차이가 없다
    const db: Schema = structuredClone(erd);
    delete db.tables[0]!.columns[1]!.privacy;
    const d = getDialect('mysql');
    expect(diffSchemas(db, erd, d).changes).toEqual([]);
    // DB에서 컬럼 타입이 바뀌어 가져와도 표시는 그대로
    db.tables[0]!.columns[1]!.length = '20';
    const pulled = applyChanges(erd, diffSchemas(erd, db, d));
    expect(pulled.tables[0]!.columns[1]).toMatchObject({ length: '20', privacy: { kind: 'personal' } });
  });

  it('정의서: 설명 칸에 [종류], "개인정보 항목" 시트', async () => {
    const schema = applyCommands(emptySchema(), [
      { op: 'createTable', name: 'member', logicalName: '회원', columns: [{ name: 'member_id', type: 'BIGINT', primaryKey: true }, { name: 'rrn', logicalName: '주민등록번호', type: 'VARCHAR(256)', privacy: 'unique' }, { name: 'pwd', type: 'VARCHAR(100)', privacy: 'password', encrypted: true }] },
    ]).schema;
    const wb = await buildDefinitionWorkbook(schema, { projectName: 'p', dialect: 'mysql' });
    const sheet = wb.getWorksheet('개인정보 항목') as ExcelJS.Worksheet;
    const text = (r: number) => (sheet.getRow(r).values as unknown[]).slice(1).map((v) => String(v ?? ''));
    expect(text(2)[0]).toContain('암호화 표시 없음 1개');
    expect(text(5)).toEqual(expect.arrayContaining(['member', 'rrn', '고유식별정보', 'N (필요)']));
    expect(text(6)).toEqual(expect.arrayContaining(['pwd', '비밀번호', 'Y']));
    const member = wb.getWorksheet('member')!;
    const cells: string[] = [];
    member.eachRow((row) => cells.push(String(row.getCell(11).value ?? '')));
    expect(cells).toContain('[고유식별정보]');
    expect(cells).toContain('[비밀번호 · 암호화]');
  });
});
