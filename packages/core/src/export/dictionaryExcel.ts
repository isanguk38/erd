// 표준 용어 사전 엑셀: 올리기(읽기)와 양식·내려받기(쓰기). 브라우저에서 쓴다.
// 회사마다 양식이 달라 머리글 이름으로 칸을 찾는다 (용어명/논리명, 영문약어명/물리명, 데이터타입/타입, 길이, 설명).

import ExcelJS from 'exceljs';
import { splitDictType, type DictConflict, type DictTerm, type DictWord, type Dictionary } from '../dictionary';

export interface DictionaryImport {
  terms: DictTerm[];
  words: DictWord[];
  /** 읽은 시트와 건너뛴 시트 안내 */
  notes: string[];
}

type Field = 'logical' | 'physical' | 'type' | 'length' | 'description';

/** 머리글 → 칸 종류. 앞에 있는 규칙이 우선 */
const HEADER_RULES: [Field, RegExp, number][] = [
  // 물리명: 약어 > 물리 > 영문 (영문명은 풀네임일 때가 많아 약어 칸이 있으면 그걸 쓴다)
  ['physical', /약어|abbr/i, 3],
  ['physical', /물리|physical|컬럼\s*id|column\s*name/i, 2],
  ['physical', /영문|english/i, 1],
  ['logical', /논리|용어\s*명|^용어$|단어\s*명|^단어$|한글|logical|^term|^word/i, 2],
  ['type', /데이터\s*타입|자료\s*형|데이터\s*형|^타입|type/i, 2],
  ['length', /길이|자리\s*수|length|size/i, 2],
  ['description', /설명|정의|비고|description|desc/i, 1],
];

function classify(header: string): [Field, number] | null {
  const h = header.replace(/\s+/g, ' ').trim();
  if (!h) return null;
  for (const [field, re, score] of HEADER_RULES) if (re.test(h)) return [field, score];
  return null;
}

const cellText = (cell: ExcelJS.Cell): string => {
  const v = cell.value;
  if (v === null || v === undefined) return '';
  if (typeof v === 'object' && 'result' in v) return String((v as { result?: unknown }).result ?? '').trim();
  return (cell.text ?? String(v)).trim();
};

/** 시트에서 머리글 줄과 칸 위치 찾기 (위에서 10줄 안) */
function findHeader(sheet: ExcelJS.Worksheet): { row: number; cols: Partial<Record<Field, number>> } | null {
  for (let r = 1; r <= Math.min(10, sheet.rowCount); r++) {
    const row = sheet.getRow(r);
    const cols: Partial<Record<Field, number>> = {};
    const scores: Partial<Record<Field, number>> = {};
    row.eachCell((cell, col) => {
      const hit = classify(cellText(cell));
      if (!hit) return;
      const [field, score] = hit;
      if ((scores[field] ?? 0) < score) {
        scores[field] = score;
        cols[field] = col;
      }
    });
    if (cols.logical && cols.physical && cols.logical !== cols.physical) return { row: r, cols };
  }
  return null;
}

export async function parseDictionaryWorkbook(data: ArrayBuffer): Promise<DictionaryImport> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data);
  const out: DictionaryImport = { terms: [], words: [], notes: [] };
  for (const sheet of wb.worksheets) {
    if (/안내|설명서|readme|충돌/i.test(sheet.name)) continue;
    const header = findHeader(sheet);
    if (!header) {
      out.notes.push(`"${sheet.name}" 시트: 논리명·물리명 머리글을 찾지 못해 건너뜀`);
      continue;
    }
    // 시트 이름에 "단어"가 있거나 타입 칸이 없으면 단어 사전, 아니면 용어 사전
    const isWords = /단어|word/i.test(sheet.name) || (!/용어|term/i.test(sheet.name) && !header.cols.type);
    const { cols } = header;
    let count = 0;
    for (let r = header.row + 1; r <= sheet.rowCount; r++) {
      const row = sheet.getRow(r);
      const get = (f: Field) => (cols[f] ? cellText(row.getCell(cols[f]!)) : '');
      const logical = get('logical');
      const physical = get('physical');
      if (!logical || !physical) continue;
      const description = get('description') || undefined;
      if (isWords) {
        out.words.push({ logical, physical, ...(description ? { description } : {}) });
      } else {
        const t = splitDictType(get('type'), get('length'));
        out.terms.push({ logical, physical, ...(t.type ? { type: t.type } : {}), ...(t.length ? { length: t.length } : {}), ...(description ? { description } : {}) });
      }
      count++;
    }
    out.notes.push(`"${sheet.name}" 시트: ${isWords ? '표준 단어' : '표준 용어'} ${count}개`);
  }
  return out;
}

const HEADER_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCE6F1' } };

const SAMPLE_TERMS: DictTerm[] = [
  { logical: '회원번호', physical: 'MBR_NO', type: 'VARCHAR', length: '20', description: '회원을 구분하는 번호' },
  { logical: '회원명', physical: 'MBR_NM', type: 'VARCHAR', length: '100' },
  { logical: '주문번호', physical: 'ORD_NO', type: 'VARCHAR', length: '20' },
  { logical: '주문금액', physical: 'ORD_AMT', type: 'DECIMAL', length: '15,2' },
  { logical: '사용여부', physical: 'USE_YN', type: 'CHAR', length: '1', description: 'Y/N' },
  { logical: '등록일시', physical: 'REG_DT', type: 'DATETIME' },
];
const SAMPLE_WORDS: DictWord[] = [
  { logical: '회원', physical: 'MBR' },
  { logical: '주문', physical: 'ORD' },
  { logical: '상품', physical: 'PRD' },
  { logical: '번호', physical: 'NO' },
  { logical: '명', physical: 'NM' },
  { logical: '금액', physical: 'AMT' },
  { logical: '수량', physical: 'QTY' },
  { logical: '일시', physical: 'DT' },
  { logical: '등록', physical: 'REG' },
  { logical: '수정', physical: 'MOD' },
  { logical: '여부', physical: 'YN' },
  { logical: '사용', physical: 'USE' },
];

/** 사전 엑셀. dict가 없으면 예시가 든 빈 양식 */
export async function dictionaryWorkbook(dict: Dictionary | null, options: { conflicts?: DictConflict[] } = {}): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook();
  const terms = wb.addWorksheet('표준용어');
  terms.columns = [
    { header: '논리명', key: 'logical', width: 22 },
    { header: '물리명', key: 'physical', width: 24 },
    { header: '타입', key: 'type', width: 14 },
    { header: '길이', key: 'length', width: 10 },
    { header: '설명', key: 'description', width: 40 },
  ];
  for (const t of dict ? dict.terms : SAMPLE_TERMS) terms.addRow(t);
  const words = wb.addWorksheet('표준단어');
  words.columns = [
    { header: '논리명', key: 'logical', width: 18 },
    { header: '물리명', key: 'physical', width: 18 },
    { header: '설명', key: 'description', width: 40 },
  ];
  for (const w of dict ? dict.words : SAMPLE_WORDS) words.addRow(w);
  for (const sheet of [terms, words]) {
    sheet.getRow(1).eachCell((c) => {
      c.fill = HEADER_FILL;
      c.font = { bold: true };
    });
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
  }
  // ERD에서 만든 초안: 같은 논리명인데 이름·타입이 다른 것 (검토용. 다시 올릴 때는 읽지 않음)
  if (options.conflicts?.length) {
    const sheet = wb.addWorksheet('충돌(검토)');
    sheet.columns = [
      { header: '논리명', key: 'logical', width: 20 },
      { header: '물리명', key: 'physical', width: 22 },
      { header: '타입', key: 'type', width: 16 },
      { header: '쓰는 곳 수', key: 'count', width: 10 },
      { header: '사전에 넣음', key: 'chosen', width: 10 },
      { header: '쓰는 곳 (테이블.컬럼)', key: 'columns', width: 70 },
    ];
    for (const c of options.conflicts) {
      c.variants.forEach((v, i) => sheet.addRow({ logical: i === 0 ? c.logical : '', physical: v.physical, type: `${v.type}${v.length ? `(${v.length})` : ''}`, count: v.columns.length, chosen: i === 0 ? 'O' : '', columns: v.columns.join(', ') }));
    }
    sheet.getRow(1).eachCell((c) => {
      c.fill = HEADER_FILL;
      c.font = { bold: true };
    });
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
  }
  const guide = wb.addWorksheet('안내');
  guide.getColumn(1).width = 100;
  [
    '표준 용어 사전 양식',
    '',
    '· 표준용어 시트: 논리명(한글 용어) → 물리명·타입·길이. 컬럼 논리명을 입력하면 이 값으로 채우고, 다르면 설계 검사에서 알려 줍니다.',
    '· 표준단어 시트: 단어 → 약어. 용어에 없는 논리명은 단어를 이어 붙여 물리명을 만듭니다 (예: 상품 + 수량 → PRD_QTY).',
    '· 타입 칸에 VARCHAR(20)처럼 길이를 함께 써도 됩니다. 타입을 비우면 타입은 검사하지 않습니다.',
    '· 회사 양식을 그대로 올려도 됩니다: 머리글 이름(용어명·논리명 / 영문약어명·물리명 / 데이터타입 / 길이 / 설명)으로 칸을 찾습니다.',
    '· 시트 이름에 "단어"가 있으면 단어 사전으로 읽습니다. 이 안내 시트는 읽지 않습니다.',
  ].forEach((line, i) => {
    const cell = guide.getCell(i + 1, 1);
    cell.value = line;
    if (i === 0) cell.font = { bold: true, size: 14 };
  });
  return (await wb.xlsx.writeBuffer()) as ArrayBuffer;
}
