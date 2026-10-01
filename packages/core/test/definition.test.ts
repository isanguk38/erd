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
