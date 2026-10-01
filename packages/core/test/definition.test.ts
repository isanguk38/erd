import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { parseDdl } from '../src';
import { buildDefinitionXlsx } from '../src/export/definition';
import { autoLayout } from '../src/layout';

const DDL = `
CREATE TABLE member (
  member_id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY COMMENT '회원번호',
  email VARCHAR(100) NOT NULL UNIQUE COMMENT '이메일'
) COMMENT='회원';
CREATE TABLE orders (
  order_id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY COMMENT '주문번호',
  member_id BIGINT NOT NULL COMMENT '회원번호',
  KEY ix_orders_member (member_id),
  CONSTRAINT fk_orders_member FOREIGN KEY (member_id) REFERENCES member (member_id)
) COMMENT='주문';
`;

describe('테이블 정의서', () => {
  it('표지, 목록, 테이블별 시트를 만든다', async () => {
    const { schema } = parseDdl(DDL);
    const buffer = await buildDefinitionXlsx(schema, { projectName: '쇼핑몰', dialect: 'mysql', author: '홍길동' });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    expect(wb.worksheets.map((s) => s.name)).toEqual(['표지', '테이블 목록', 'member', 'orders']);

    const list = wb.getWorksheet('테이블 목록')!;
    expect(list.getRow(4).getCell(3).value).toBe('회원');

    const orders = wb.getWorksheet('orders')!;
    const values = orders.getSheetValues().flat().filter((v) => typeof v === 'string');
    expect(values).toContain('주문번호');
    expect(values).toContain('ix_orders_member');
    expect(values).toContain('fk_orders_member');
  });

  it('한 시트 모드', async () => {
    const { schema } = parseDdl(DDL);
    const buffer = await buildDefinitionXlsx(schema, { projectName: 'p', dialect: 'mysql', layout: 'singleSheet' });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    expect(wb.worksheets.map((s) => s.name)).toEqual(['표지', '테이블 목록', '테이블 정의']);
  });
});

describe('자동 배치', () => {
  it('부모 테이블이 자식보다 왼쪽에 온다', async () => {
    const { schema } = parseDdl(DDL);
    const positions = await autoLayout(schema);
    expect(positions.get(schema.tables[0].id)!.x).toBeLessThan(positions.get(schema.tables[1].id)!.x);
  });
});

describe('테이블 정의서: 변경 이력', () => {
  it('변경 이력 시트는 테이블 목록 바로 뒤에 오고, 표지와 목록에도 표시된다', async () => {
    const { parseDdl: parse, diffSchemas, getDialect } = await import('../src');
    const before = parse(DDL).schema;
    const after = structuredClone(before);
    after.tables[0].columns.push({ ...after.tables[0].columns[1], id: 'new', name: 'nickname', unique: false });
    const changes = diffSchemas(before, after, getDialect('mysql')).changes;
    const buffer = await buildDefinitionXlsx(after, { projectName: 'p', dialect: 'mysql', changes: { title: '변경 이력 ("v1" 이후)', items: changes } });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    expect(wb.worksheets.map((s) => s.name)).toEqual(['표지', '테이블 목록', '변경 이력', 'member', 'orders']);
    const cover = wb.getWorksheet('표지')!.getSheetValues().flat().map((v) => (typeof v === 'object' && v && 'text' in v ? v.text : v));
    expect(cover).toContain('변경 이력 ("v1" 이후) · 1건 ("변경 이력" 시트)');
    const history = wb.getWorksheet('변경 이력')!.getSheetValues().flat();
    expect(history).toContain('member.nickname 컬럼 추가');
    const list = wb.getWorksheet('테이블 목록')!;
    expect(list.getRow(3).getCell(6).value).toBe('변경');
    expect(list.getRow(4).getCell(6).value).toBe('수정');
    expect(list.getRow(5).getCell(6).value).toBe('');
  });

  it('바뀐 것이 없으면 "변경 없음"이라고 쓴다', async () => {
    const { schema } = parseDdl(DDL);
    const buffer = await buildDefinitionXlsx(schema, { projectName: 'p', dialect: 'mysql', changes: { title: 't', items: [] } });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    expect(wb.getWorksheet('변경 이력')!.getSheetValues().flat()).toContain('변경 없음 (기준 버전과 지금 ERD가 같습니다)');
  });
});
