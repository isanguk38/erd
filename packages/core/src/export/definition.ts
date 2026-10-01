// 테이블 정의서(Excel). 브라우저와 서버(MCP)에서 모두 쓴다.

import ExcelJS from 'exceljs';
import type { Change } from '../diff';
import { getDialect } from '../dialects';
import type { DialectId } from '../dialects/types';
import { findTable, indexName, relationName, type Schema, type Table } from '../model';
import { foreignKeyColumnIds } from '../operations';

export interface DefinitionOptions {
  projectName: string;
  dialect: DialectId;
  author?: string;
  version?: string;
  /** 테이블마다 시트를 나눌지, 한 시트에 이어 붙일지 */
  layout?: 'sheetPerTable' | 'singleSheet';
  /** 넣으면 "변경 이력" 시트를 만든다 */
  changes?: { title: string; items: Change[] };
  date?: Date;
}

const HEADER_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCE6F1' } };
const LABEL_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } };
const TITLE_FONT: Partial<ExcelJS.Font> = { bold: true, size: 16 };
const BOLD: Partial<ExcelJS.Font> = { bold: true };
const THIN: Partial<ExcelJS.Borders> = {
  top: { style: 'thin', color: { argb: 'FFBFBFBF' } },
  left: { style: 'thin', color: { argb: 'FFBFBFBF' } },
  bottom: { style: 'thin', color: { argb: 'FFBFBFBF' } },
  right: { style: 'thin', color: { argb: 'FFBFBFBF' } },
};

const COLUMN_HEADERS = ['No', '컬럼명(논리)', '컬럼명(물리)', '타입', '길이', 'PK', 'FK', 'NULL', '자동증가', '기본값', '설명'];
const COLUMN_WIDTHS = [6, 22, 24, 16, 10, 6, 6, 8, 9, 20, 36];

function styleRow(row: ExcelJS.Row, options: { header?: boolean; from?: number; to?: number } = {}) {
  const from = options.from ?? 1;
  const to = options.to ?? COLUMN_HEADERS.length;
  for (let i = from; i <= to; i++) {
    const cell = row.getCell(i);
    cell.border = THIN;
    cell.alignment = { vertical: 'middle', wrapText: true, horizontal: options.header ? 'center' : cell.alignment?.horizontal };
    if (options.header) {
      cell.fill = HEADER_FILL;
      cell.font = BOLD;
    }
  }
}

/** 시트 이름 규칙: 31자 이하, []:*?/\ 사용 불가, 중복 불가 */
function sheetNames(tables: Table[]): Map<string, string> {
  const used = new Set(['표지', '테이블 목록', '변경 이력']);
  const names = new Map<string, string>();
  for (const t of tables) {
    const base = t.name.replace(/[[\]:*?/\\]/g, '_').slice(0, 28) || 'table';
    let name = base;
    for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base.slice(0, 26)}_${i}`;
    used.add(name.toLowerCase());
    names.set(t.id, name);
  }
  return names;
}

function writeTableBlock(sheet: ExcelJS.Worksheet, schema: Schema, table: Table, dialect: DialectId, backLink: boolean): void {
  const fk = foreignKeyColumnIds(schema, table.id);
  const d = getDialect(dialect);
  const span = COLUMN_HEADERS.length;

  const info: [string, string][] = [
    ['테이블명(물리)', table.name],
    ['테이블명(논리)', table.logicalName],
    ['설명', table.comment],
  ];
  for (const [label, value] of info) {
    const row = sheet.addRow([label, value]);
    sheet.mergeCells(row.number, 2, row.number, span);
    row.getCell(1).fill = LABEL_FILL;
    row.getCell(1).font = BOLD;
    styleRow(row);
  }
  if (backLink) {
    const row = sheet.addRow([]);
    row.getCell(span).value = { text: '← 테이블 목록', hyperlink: "#'테이블 목록'!A1" };
    row.getCell(span).font = { color: { argb: 'FF2563EB' }, underline: true };
  }
  sheet.addRow([]);

  styleRow(sheet.addRow(COLUMN_HEADERS), { header: true });
  table.columns.forEach((c, i) => {
    const pk = c.primaryKey;
    const row = sheet.addRow([
      i + 1,
      c.logicalName,
      c.name,
      d.renderType({ ...c, length: '' }),
      c.length,
      pk ? 'Y' : '',
      fk.has(c.id) ? 'Y' : '',
      c.nullable && !pk ? 'Y' : 'N',
      c.autoIncrement ? 'Y' : '',
      c.defaultValue ?? '',
      c.comment,
    ]);
    styleRow(row);
    for (const col of [1, 5, 6, 7, 8, 9]) row.getCell(col).alignment = { horizontal: 'center', vertical: 'middle' };
  });

  if (table.indexes.length || table.columns.some((c) => c.unique && !c.primaryKey)) {
    sheet.addRow([]);
    const head = sheet.addRow(['No', '인덱스명', '컬럼', '', '', 'UNIQUE']);
    sheet.mergeCells(head.number, 3, head.number, 5);
    styleRow(head, { header: true, to: 6 });
    const indexes = [
      ...table.indexes,
      ...table.columns.filter((c) => c.unique && !c.primaryKey && !table.indexes.some((i) => i.unique && i.columnIds.length === 1 && i.columnIds[0] === c.id))
        .map((c) => ({ id: c.id, name: '', columnIds: [c.id], unique: true })),
    ];
    indexes.forEach((index, i) => {
      const cols = index.columnIds.map((id) => table.columns.find((c) => c.id === id)?.name ?? '?').join(', ');
      const row = sheet.addRow([i + 1, indexName(table, index), cols, '', '', index.unique ? 'Y' : '']);
      sheet.mergeCells(row.number, 3, row.number, 5);
      styleRow(row, { to: 6 });
    });
  }

  const relations = schema.relations.filter((r) => r.fromTableId === table.id);
  if (relations.length) {
    sheet.addRow([]);
    const head = sheet.addRow(['No', '외래키명', '컬럼', '참조 테이블', '참조 컬럼', '', '', 'ON DELETE', '', 'ON UPDATE']);
    sheet.mergeCells(head.number, 5, head.number, 7);
    sheet.mergeCells(head.number, 8, head.number, 9);
    styleRow(head, { header: true, to: 10 });
    relations.forEach((r, i) => {
      const parent = findTable(schema, r.toTableId);
      const cols = r.fromColumnIds.map((id) => table.columns.find((c) => c.id === id)?.name ?? '?').join(', ');
      const refCols = r.toColumnIds.map((id) => parent?.columns.find((c) => c.id === id)?.name ?? '?').join(', ');
      const row = sheet.addRow([i + 1, relationName(schema, r), cols, parent?.name ?? '?', refCols, '', '', r.onDelete, '', r.onUpdate]);
      sheet.mergeCells(row.number, 5, row.number, 7);
      sheet.mergeCells(row.number, 8, row.number, 9);
      styleRow(row, { to: 10 });
    });
  }
}

export async function buildDefinitionWorkbook(schema: Schema, options: DefinitionOptions): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  const date = options.date ?? new Date();
  wb.creator = options.author || 'ERD';
  wb.created = date;
  const tables = [...schema.tables];
  const layout = options.layout ?? 'sheetPerTable';
  const names = sheetNames(tables);

  // 표지
  const cover = wb.addWorksheet('표지', { views: [{ showGridLines: false }] });
  cover.columns = [{ width: 4 }, { width: 18 }, { width: 50 }];
  cover.addRow([]);
  cover.addRow([]);
  const title = cover.addRow(['', '테이블 정의서']);
  title.getCell(2).font = { bold: true, size: 24 };
  cover.addRow([]);
  const coverInfo: [string, string][] = [
    ['프로젝트', options.projectName],
    ['DB', getDialect(options.dialect).label],
    ['버전', options.version ?? ''],
    ['작성자', options.author ?? ''],
    ['작성일', date.toISOString().slice(0, 10)],
    ['테이블 수', String(tables.length)],
  ];
  for (const [label, value] of coverInfo) {
    const row = cover.addRow(['', label, value]);
    row.getCell(2).font = BOLD;
    row.getCell(2).fill = LABEL_FILL;
    row.getCell(2).border = THIN;
    row.getCell(3).border = THIN;
  }

  // 테이블 목록
  const list = wb.addWorksheet('테이블 목록');
  list.columns = [{ width: 6 }, { width: 28 }, { width: 24 }, { width: 50 }, { width: 10 }];
  const listTitle = list.addRow(['테이블 목록']);
  listTitle.getCell(1).font = TITLE_FONT;
  list.addRow([]);
  styleRow(list.addRow(['No', '테이블명(물리)', '테이블명(논리)', '설명', '컬럼 수']), { header: true, to: 5 });
  tables.forEach((t, i) => {
    const row = list.addRow([i + 1, t.name, t.logicalName, t.comment, t.columns.length]);
    if (layout === 'sheetPerTable') {
      row.getCell(2).value = { text: t.name, hyperlink: `#'${names.get(t.id)}'!A1` };
      row.getCell(2).font = { color: { argb: 'FF2563EB' }, underline: true };
    }
    styleRow(row, { to: 5 });
    row.getCell(1).alignment = { horizontal: 'center' };
    row.getCell(5).alignment = { horizontal: 'center' };
  });

  // 테이블 상세
  if (layout === 'sheetPerTable') {
    for (const t of tables) {
      const sheet = wb.addWorksheet(names.get(t.id)!);
      sheet.columns = COLUMN_WIDTHS.map((width) => ({ width }));
      writeTableBlock(sheet, schema, t, options.dialect, true);
    }
  } else {
    const sheet = wb.addWorksheet('테이블 정의');
    sheet.columns = COLUMN_WIDTHS.map((width) => ({ width }));
    tables.forEach((t, i) => {
      if (i > 0) { sheet.addRow([]); sheet.addRow([]); }
      writeTableBlock(sheet, schema, t, options.dialect, false);
    });
  }

  // 변경 이력
  if (options.changes) {
    const sheet = wb.addWorksheet('변경 이력');
    sheet.columns = [{ width: 6 }, { width: 10 }, { width: 24 }, { width: 70 }, { width: 50 }];
    const head = sheet.addRow([options.changes.title]);
    head.getCell(1).font = TITLE_FONT;
    sheet.addRow([]);
    styleRow(sheet.addRow(['No', '구분', '테이블', '내용', '주의']), { header: true, to: 5 });
    const label = { create: '생성', alter: '수정', drop: '삭제' } as const;
    options.changes.items.forEach((c, i) => {
      styleRow(sheet.addRow([i + 1, label[c.category], c.tableName, c.summary, c.warning ?? '']), { to: 5 });
    });
  }

  return wb;
}

/** 엑셀 파일 내용 (브라우저: Blob으로 감싸 다운로드, 서버: 파일로 저장) */
export async function buildDefinitionXlsx(schema: Schema, options: DefinitionOptions): Promise<ArrayBuffer> {
  const wb = await buildDefinitionWorkbook(schema, options);
  return (await wb.xlsx.writeBuffer()) as ArrayBuffer;
}
