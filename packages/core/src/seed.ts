// 테스트 데이터: ERD를 보고 외래키·NOT NULL·UNIQUE·ENUM·간단한 CHECK를 지키는 가짜 데이터를 INSERT 문으로 만든다.
// 부모 테이블을 먼저 채우고 자식의 FK는 이미 만든 부모 행에서 고른다. 값은 컬럼 이름·논리명·타입을 보고 그럴듯하게
// (이름 → 한국 이름, phone → 010-…, email → user1@example.com, 금액 → 1000원 단위 등) 만든다.
// 같은 seed면 늘 같은 데이터가 나온다 (미리보기와 실행이 같도록).

import type { Dialect } from './dialects/types';
import { enumOfType, parseEnumValueList } from './enums';
import { isToolTable } from './naming';
import type { Column, Relation, Schema, Table } from './model';

export interface SeedOptions {
  /** 테이블마다 만들 행 수 (기본 20, 최대 10000) */
  rows?: number;
  /** 테이블별 행 수 (테이블 id → 행 수). 없는 테이블은 rows */
  rowsByTable?: Record<string, number>;
  /** 이 테이블만 (NOT NULL 외래키의 부모는 자동으로 함께). 없으면 전체 */
  tableIds?: string[];
  /** 정수 기본키·UNIQUE 정수의 시작 번호 (기본 1). DB에 이미 데이터가 있으면 겹치지 않게 크게 */
  startId?: number;
  /** 같은 seed면 같은 데이터 (기본 1) */
  seed?: number;
}

export interface SeedResult {
  /** 실행할 SQL (세미콜론 없이). 부모 테이블부터 */
  statements: string[];
  /** 테이블별로 만든 행 수 (만든 순서) */
  tables: { id: string; name: string; rows: number }[];
  /** NOT NULL 외래키 때문에 함께 넣은 부모 테이블 */
  added: string[];
  /** 만들지 못한 테이블과 까닭 */
  skipped: { name: string; reason: string }[];
  warnings: string[];
}

export const SEED_MAX_ROWS = 10000;

// ── 값 만들기 도구 ───────────────────────────────

/** 같은 seed면 같은 수열 (mulberry32) */
function random(seed: number) {
  let a = seed >>> 0 || 1;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number) => Math.floor(next() * (max - min + 1)) + min;
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(next() * list.length)]!;
  return { next, int, pick };
}
type Rng = ReturnType<typeof random>;

const SURNAMES = ['김', '이', '박', '최', '정', '강', '조', '윤', '장', '임', '한', '오', '서', '신', '권', '황', '안', '송', '류', '홍'];
const GIVEN = ['민준', '서연', '도윤', '서윤', '예준', '지우', '시우', '하은', '주원', '지호', '하준', '수아', '지유', '윤서', '건우', '채원', '유준', '지민', '현우', '다은'];
const STREETS = ['서울특별시 강남구 테헤란로', '서울특별시 마포구 월드컵북로', '부산광역시 해운대구 센텀중앙로', '경기도 성남시 분당구 판교역로', '인천광역시 연수구 송도과학로', '대구광역시 수성구 달구벌대로', '대전광역시 유성구 대학로', '광주광역시 서구 상무중앙로'];
const COMPANIES = ['한빛상사', '푸른소프트', '새솔유통', '다온물산', '미래테크', '하늘식품'];
const STATUS = ['READY', 'ACTIVE', 'DONE', 'CANCEL'];
const pad = (n: number, w = 2) => String(n).padStart(w, '0');
const hex = (rng: Rng, n: number) => Array.from({ length: n }, () => '0123456789abcdef'[rng.int(0, 15)]).join('');

/** 컬럼 타입 갈래 */
type Kind = 'int' | 'decimal' | 'float' | 'bool' | 'date' | 'datetime' | 'time' | 'year' | 'string' | 'json' | 'uuid' | 'binary' | 'enum' | 'unknown';

const INT = new Set(['TINYINT', 'SMALLINT', 'MEDIUMINT', 'INT', 'INTEGER', 'BIGINT', 'INT2', 'INT4', 'INT8', 'SERIAL', 'BIGSERIAL', 'SMALLSERIAL', 'SERIAL2', 'SERIAL4', 'SERIAL8', 'PLS_INTEGER']);
const DECIMAL = new Set(['DECIMAL', 'NUMERIC', 'DEC', 'MONEY', 'SMALLMONEY', 'NUMBER']);
const FLOAT = new Set(['FLOAT', 'DOUBLE', 'REAL', 'FLOAT4', 'FLOAT8', 'BINARY_FLOAT', 'BINARY_DOUBLE']);
const BOOL = new Set(['BOOLEAN', 'BOOL', 'BIT']);
const DATETIME = new Set(['DATETIME', 'DATETIME2', 'SMALLDATETIME', 'TIMESTAMP', 'TIMESTAMPTZ', 'DATETIMEOFFSET']);
const TIME = new Set(['TIME', 'TIMETZ']);
const STRING = new Set(['CHAR', 'VARCHAR', 'NCHAR', 'NVARCHAR', 'VARCHAR2', 'NVARCHAR2', 'TEXT', 'TINYTEXT', 'MEDIUMTEXT', 'LONGTEXT', 'NTEXT', 'CLOB', 'NCLOB', 'CHARACTER', 'CITEXT', 'STRING', 'LONG']);
const BINARY = new Set(['BLOB', 'TINYBLOB', 'MEDIUMBLOB', 'LONGBLOB', 'BINARY', 'VARBINARY', 'BYTEA', 'RAW', 'IMAGE', 'LONG RAW']);

const baseOf = (c: Column) => c.type.trim().toUpperCase().split(/[\s(]/)[0]!;
const precision = (c: Column) => {
  const [p, s] = c.length.split(',').map((x) => Number(x.trim()));
  return { p: Number.isFinite(p) && p! > 0 ? p! : undefined, s: Number.isFinite(s) ? s! : 0 };
};

function kindOf(c: Column, values: string[] | null): Kind {
  if (values) return 'enum';
  const t = c.type.trim().toUpperCase();
  const base = baseOf(c);
  if (/^DOUBLE PRECISION/.test(t)) return 'float';
  if (/^CHARACTER VARYING/.test(t)) return 'string';
  if (/^TIMESTAMP/.test(t)) return 'datetime';
  if (base === 'TINYINT' && c.length.trim() === '1') return 'bool';
  if (base === 'BIT' && c.length.trim() && c.length.trim() !== '1') return 'unknown';
  if (base === 'NUMBER') return precision(c).s > 0 ? 'decimal' : 'int';
  if (INT.has(base)) return 'int';
  if (DECIMAL.has(base)) return 'decimal';
  if (FLOAT.has(base)) return 'float';
  if (BOOL.has(base)) return 'bool';
  if (base === 'DATE') return 'date';
  if (DATETIME.has(base)) return 'datetime';
  if (TIME.has(base)) return 'time';
  if (base === 'YEAR') return 'year';
  if (base === 'JSON' || base === 'JSONB') return 'json';
  if (base === 'UUID' || base === 'UNIQUEIDENTIFIER') return 'uuid';
  if (BINARY.has(base) || /^LONG RAW/.test(t)) return 'binary';
  if (STRING.has(base)) return 'string';
  return 'unknown';
}

/** 정수 타입이 담을 수 있는 가장 큰 값 */
function intMax(c: Column): number {
  const base = baseOf(c);
  const unsigned = /UNSIGNED/i.test(c.type);
  if (base === 'TINYINT') return unsigned ? 255 : 127;
  if (base === 'SMALLINT' || base === 'INT2' || base === 'SMALLSERIAL' || base === 'SERIAL2') return 32767;
  if (base === 'MEDIUMINT') return 8388607;
  if (base === 'NUMBER') {
    const { p } = precision(c);
    return p ? Math.min(10 ** Math.min(p, 15) - 1, Number.MAX_SAFE_INTEGER) : 2147483647;
  }
  return 2147483647;
}

/** 이름·논리명으로 값 성격 알기 */
function nameHint(c: Column): string {
  return `${c.name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()} ${c.logicalName}`;
}
const has = (hint: string, re: RegExp) => re.test(hint);

/** CHECK 식에서 읽은 컬럼별 조건 (간단한 것만: IN, 비교, BETWEEN) */
interface Rule {
  values?: string[];
  min?: number;
  max?: number;
}

function checkRules(table: Table, warnings: string[]): Map<string, Rule> {
  const rules = new Map<string, Rule>();
  const rule = (name: string) => {
    const c = table.columns.find((x) => x.name.toLowerCase() === name.replace(/["`[\]]/g, '').toLowerCase());
    if (!c) return null;
    if (!rules.has(c.id)) rules.set(c.id, {});
    return rules.get(c.id)!;
  };
  const ident = String.raw`["\`\[]?([A-Za-z_][\w$]*)["\`\]]?`;
  const num = String.raw`(-?\d+(?:\.\d+)?)`;
  for (const k of table.checks ?? []) {
    let understood = false;
    // BETWEEN a AND b의 AND는 나누지 않는다
    const parts = k.expression.replace(/(BETWEEN\s+\S+)\s+AND\s+/gi, '$1 \u0001 ').split(/\s+AND\s+(?![^()]*\))/i);
    for (const part of parts) {
      const p = part.replace(/\u0001/g, 'AND').trim().replace(/^\((.*)\)$/s, '$1').trim();
      let m: RegExpMatchArray | null;
      if ((m = p.match(new RegExp(`^${ident}\\s+IN\\s*\\((.*)\\)$`, 'is')))) {
        const r = rule(m[1]!);
        const values = /'/.test(m[2]!) ? parseEnumValueList(m[2]!) : m[2]!.split(',').map((x) => x.trim()).filter(Boolean);
        if (r && values.length) (r.values = values), (understood = true);
      } else if ((m = p.match(new RegExp(`^${ident}\\s+BETWEEN\\s+${num}\\s+AND\\s+${num}$`, 'i')))) {
        const r = rule(m[1]!);
        if (r) (r.min = Number(m[2])), (r.max = Number(m[3])), (understood = true);
      } else if ((m = p.match(new RegExp(`^${ident}\\s*(>=|>|<=|<)\\s*${num}$`)))) {
        const r = rule(m[1]!);
        const n = Number(m[3]);
        if (r) {
          if (m[2] === '>=') r.min = n;
          if (m[2] === '>') r.min = n + (Number.isInteger(n) ? 1 : 0.01);
          if (m[2] === '<=') r.max = n;
          if (m[2] === '<') r.max = n - (Number.isInteger(n) ? 1 : 0.01);
          understood = true;
        }
      } else if ((m = p.match(new RegExp(`^${ident}\\s+IS\\s+NOT\\s+NULL$`, 'i'))) || (m = p.match(new RegExp(`^${ident}\\s*<>\\s*''$`)))) {
        understood = Boolean(rule(m[1]!));
      } else {
        understood = false;
        break;
      }
    }
    if (!understood) warnings.push(`${table.name}: CHECK (${k.expression.trim()})는 확인하지 못했습니다 — 실행하다 이 조건에 걸리면 값을 고치세요`);
  }
  return rules;
}

/** 값 하나 만들기. i: 0부터 시작하는 행 번호 */
function makeValue(c: Column, kind: Kind, i: number, rng: Rng, ctx: { start: number; values: string[] | null; rule?: Rule; byteLimit: boolean; hint: string; text?: TextMaker; uniqueText?: boolean }): unknown {
  const hint = ctx.hint;
  const rule = ctx.rule;
  if (rule?.values?.length) {
    const v = rng.pick(rule.values);
    return kind === 'int' || kind === 'decimal' || kind === 'float' ? Number(v) : v;
  }
  const clamp = (n: number) => Math.min(rule?.max ?? Infinity, Math.max(rule?.min ?? -Infinity, n));
  switch (kind) {
    case 'enum':
      return rng.pick(ctx.values!);
    case 'int': {
      const max = intMax(c);
      let n: number;
      if (c.primaryKey || c.unique || c.autoIncrement) n = ctx.start + i;
      else if (has(hint, /(^|_)(cnt|count|qty|quantity)(_|$| )|수량|개수|건수/)) n = rng.int(1, 100);
      else if (has(hint, /(^|_)(price|amount|amt|fee|cost|total|pay|balance)(_|$| )|금액|가격|단가|요금|비용|잔액/)) n = rng.int(1, 500) * 1000;
      else if (has(hint, /(^|_)age(_|$| )|나이|연령/)) n = rng.int(18, 80);
      else if (has(hint, /(^|_)(point|score|mileage)(_|$| )|포인트|점수|마일리지/)) n = rng.int(0, 1000) * 10;
      else if (has(hint, /(^|_)(sort|ord|order|seq|sort_order|rank)(_|$| )|순서|순번|정렬/)) n = i + 1;
      else if (has(hint, /(^|_)year(_|$| )|연도|년도/)) n = rng.int(2015, 2026);
      else if (has(hint, /(^|_)(yn|flag|is_[a-z]+|use|del)(_|$| )|여부/)) n = rng.int(0, 1);
      else n = rng.int(1, 1000);
      return Math.round(clamp(Math.min(n, max)));
    }
    case 'decimal': {
      const { p, s } = precision(c);
      const limit = p ? 10 ** Math.min(p - s, 12) - 1 : 1_000_000;
      let n: number;
      if (c.primaryKey || c.unique) n = ctx.start + i;
      else if (has(hint, /(^|_)(rate|ratio|pct|percent)(_|$| )|비율|율$|퍼센트/)) n = rng.int(0, 10000) / 100;
      else if (has(hint, /(^|_)(price|amount|amt|fee|cost|total|pay|balance)(_|$| )|금액|가격|단가|요금|비용|잔액/)) n = rng.int(1, 500) * 1000;
      else n = rng.int(0, 100000) / 100;
      n = clamp(Math.min(n, limit));
      return Number(n.toFixed(s));
    }
    case 'float':
      return Number(clamp(rng.int(0, 100000) / 100).toFixed(2));
    case 'bool':
      return rng.next() < 0.7;
    case 'date': {
      const birth = has(hint, /birth|dob|생년|생일/);
      const y = birth ? rng.int(1960, 2005) : rng.int(2023, 2026);
      return `${y}-${pad(rng.int(1, 12))}-${pad(rng.int(1, 28))}`;
    }
    case 'datetime':
      return `${rng.int(2023, 2026)}-${pad(rng.int(1, 12))}-${pad(rng.int(1, 28))} ${pad(rng.int(0, 23))}:${pad(rng.int(0, 59))}:${pad(rng.int(0, 59))}`;
    case 'time':
      return `${pad(rng.int(0, 23))}:${pad(rng.int(0, 59))}:${pad(rng.int(0, 59))}`;
    case 'year':
      return rng.int(2015, 2026);
    case 'json':
      return `{"sample": ${i + 1}}`;
    case 'uuid':
      return `${hex(rng, 8)}-${hex(rng, 4)}-4${hex(rng, 3)}-a${hex(rng, 3)}-${hex(rng, 12)}`;
    case 'binary':
      return { binary: hex(rng, 8) };
    case 'string': {
      const n = ctx.start + i;
      let text = ctx.text!(n, rng);
      // 하나만으로 UNIQUE(또는 기본키)인 글자 컬럼: 행 번호가 들어 있지 않으면 붙여 늘 다르게 (상태·코드처럼 값이 몇 개뿐인 것도)
      if (ctx.uniqueText && !new RegExp(`(^|\\D)${n}(\\D|$)`).test(text)) text = `${text}_${n}`;
      return fitText(c, text, ctx.byteLimit);
    }
    default:
      return null;
  }
}

type TextMaker = (n: number, rng: Rng) => string;

/**
 * 컬럼 이름·논리명을 보고 글자 값을 만드는 방법을 한 번 정한다 (행마다 이름 규칙 20여 개를 다시 보지 않게).
 * n: 행 번호(시작 번호 + i)
 */
function textMaker(c: Column): TextMaker {
  const hint = nameHint(c);
  const p = c.privacy;
  // 암호화해 저장하는 개인정보는 암호문처럼, 비밀번호는 해시처럼
  if (p?.kind === 'password' || has(hint, /(^|_)(password|passwd|pwd|pw)(_|$| )|비밀번호|패스워드/)) return (_n, rng) => `$2b$10$${hex(rng, 53)}`;
  if (p?.encrypted) return (_n, rng) => hex(rng, 64);
  if (p?.kind === 'unique' || has(hint, /(^|_)(rrn|ssn|jumin)(_|$| )|주민/)) return (_n, rng) => `${pad(rng.int(60, 99))}${pad(rng.int(1, 12))}${pad(rng.int(1, 28))}-${rng.int(1, 2)}${String(rng.int(0, 999999)).padStart(6, '0')}`;
  if (has(hint, /e_?mail|이메일|메일/)) return (n) => `user${n}@example.com`;
  if (has(hint, /(^|_)(phone|mobile|tel|hp|cell|telephone)(_|$| |no|num)|전화|휴대|핸드폰|연락처/)) return (_n, rng) => `010-${rng.int(1000, 9999)}-${rng.int(1000, 9999)}`;
  if (has(hint, /(^|_)(zip|zipcode|post_?code|postal_?code)(_|$| )|우편/)) return (_n, rng) => String(rng.int(10000, 63999));
  if (has(hint, /(^|_)(addr|address)(_|$| |1|2)|주소/)) return has(hint, /detail|addr2|상세/) ? (_n, rng) => `${rng.int(1, 20)}층 ${rng.int(1, 30)}호` : (_n, rng) => `${rng.pick(STREETS)} ${rng.int(1, 300)}`;
  if (has(hint, /(^|_)(account|acct|acnt)_?(no|num)|계좌/)) return (_n, rng) => `${rng.int(100, 999)}-${rng.int(100000, 999999)}-${rng.int(10, 99)}-${rng.int(100, 999)}`;
  if (has(hint, /card_?(no|num)|카드\s*번호/)) return (_n, rng) => `${rng.int(4000, 4999)}-${rng.int(1000, 9999)}-${rng.int(1000, 9999)}-${rng.int(1000, 9999)}`;
  if (has(hint, /(^|_)(ip|ip_addr|ip_address)(_|$| )|IP\s*주소|접속\s*IP/)) return (_n, rng) => `192.168.${rng.int(0, 255)}.${rng.int(1, 254)}`;
  if (has(hint, /(^|_)(url|link|homepage|website|img|image|thumbnail|path|file)(_|$| )|주소\s*URL|링크|이미지|파일/)) return (n) => `https://example.com/files/${n}`;
  if (has(hint, /(^|_)(login_id|user_id|username|login|account_id|nickname|nick)(_|$| )|아이디|닉네임/) && !c.primaryKey) return (n) => `user${n}`;
  if (has(hint, /(^|_)(gender|sex)(_|$| )|성별/)) return (_n, rng) => rng.pick(['M', 'F']);
  if (has(hint, /(^|_)[a-z]*_?yn(_|$| )|(^|_)(use|del|is)_|여부/) || (baseOf(c) === 'CHAR' && c.length.trim() === '1')) return (_n, rng) => (rng.next() < 0.8 ? 'Y' : 'N');
  if (has(hint, /(^|_)(company|corp|vendor|shop|store|brand)_?(name|nm)?(_|$| )|회사|업체|상호|거래처/)) return (n, rng) => `${rng.pick(COMPANIES)} ${n}`;
  if (has(hint, /((^|_)(user|member|mbr|cust|customer|real|full|first|last|person|emp|employee|buyer|receiver|recipient|sender|owner|holder|guardian|writer|author|manager)_?(name|nm))(_|$| )|(^|\s)(이름|성명|실명)$|(회원|고객|사용자|수령인|수취인|주문자|보호자|예금주|직원|담당자|작성자)\s*(명|이름)/)) return (_n, rng) => `${rng.pick(SURNAMES)}${rng.pick(GIVEN)}`;
  if (has(hint, /(^|_)(status|state|stat|stts)(_|$| )|상태/)) return (_n, rng) => rng.pick(STATUS);
  if (has(hint, /(^|_)(title|subject)(_|$| )|제목/)) return (n) => `샘플 제목 ${n}`;
  if (has(hint, /(^|_)(content|contents|body|desc|description|memo|remark|note|comment|text|message|msg)(_|$| )|내용|설명|메모|비고/)) return (n) => `샘플 내용입니다 (${n})`;
  if (has(hint, /(^|_)(code|cd|type|kind|div|gb|cls)(_|$| )|코드|구분|유형|종류/)) return (_n, rng) => `C${String(rng.int(1, 99)).padStart(2, '0')}`;
  if (c.primaryKey || c.unique) {
    const prefix = c.name.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3) || 'ID';
    return (n) => `${prefix}${String(n).padStart(6, '0')}`;
  }
  const label = c.logicalName.trim() || c.name;
  return (n) => `${label} ${n}`;
}

/** 길이 안에 맞추기. byteLimit: 길이가 바이트인 DB(Oracle VARCHAR2·SQL Server VARCHAR)면 UTF-8 바이트로 */
function fitText(c: Column, text: string, byteLimit: boolean): string {
  const n = Number(c.length.split(',')[0]);
  if (!Number.isFinite(n) || n <= 0) return text;
  const size = (s: string) => (byteLimit ? new TextEncoder().encode(s).length : [...s].length);
  if (size(text) <= n) return text;
  // UNIQUE를 지키도록 뒤쪽(번호)을 남긴다
  const chars = [...text];
  while (chars.length && size(chars.join('')) > n) chars.splice(Math.max(0, chars.length - 1 - (text.match(/\d+$/)?.[0].length ?? 0)), 1);
  return chars.join('') || text.slice(0, n);
}

// ── SQL로 쓰기 ──────────────────────────────────

function render(dialect: Dialect, c: Column, kind: Kind, v: unknown): string {
  const sql = dialect.seed;
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return sql.boolean(v);
  if (typeof v === 'object' && 'binary' in (v as object)) return sql.binary((v as { binary: string }).binary);
  const s = String(v);
  if (kind === 'date' || kind === 'datetime' || kind === 'time') return sql.dateTime(s, kind, baseOf(c));
  return sql.text(s);
}

// ── 순서·행 만들기 ──────────────────────────────

export function generateSeedData(schema: Schema, dialect: Dialect, options: SeedOptions = {}): SeedResult {
  const rng = random(options.seed ?? 1);
  const start = Math.max(0, Math.floor(options.startId ?? 1));
  const rowsFor = (t: Table) => Math.max(0, Math.min(SEED_MAX_ROWS, Math.floor(options.rowsByTable?.[t.id] ?? options.rows ?? 20)));
  const warnings: string[] = [];
  const skipped: SeedResult['skipped'] = [];
  const byId = new Map(schema.tables.map((t) => [t.id, t]));
  // 테이블별 외래키 (큰 ERD에서 순서를 정할 때 매번 전체 관계를 훑지 않게)
  const fkIndex = new Map<string, Relation[]>();
  for (const r of schema.relations) if (byId.has(r.toTableId)) fkIndex.set(r.fromTableId, [...(fkIndex.get(r.fromTableId) ?? []), r]);
  const fksOf = (t: Table) => fkIndex.get(t.id) ?? [];
  const required = (t: Table, r: Relation) => r.fromColumnIds.some((id) => {
    const c = t.columns.find((x) => x.id === id);
    return c && (!c.nullable || c.primaryKey);
  });

  // 고른 테이블 + NOT NULL 외래키로 꼭 필요한 부모
  const chosen = new Set((options.tableIds ?? schema.tables.map((t) => t.id)).filter((id) => byId.has(id) && !isToolTable(byId.get(id)!.name)));
  const added: string[] = [];
  for (const id of [...chosen]) {
    const stack = [id];
    while (stack.length) {
      const t = byId.get(stack.pop()!)!;
      for (const r of fksOf(t)) {
        if (r.toTableId === t.id || chosen.has(r.toTableId) || !required(t, r)) continue;
        chosen.add(r.toTableId);
        added.push(byId.get(r.toTableId)!.name);
        stack.push(r.toTableId);
      }
    }
  }

  // 부모부터 (서로 가리키는 테이블은 NULL이 되는 외래키를 끊어서)
  const order: Table[] = [];
  const nulled = new Set<string>(); // 이번에는 NULL로 두는 외래키(관계 id)
  const pending = new Set(chosen);
  while (pending.size) {
    const ready = [...pending].filter((id) => fksOf(byId.get(id)!).every((r) => r.toTableId === id || !pending.has(r.toTableId) || nulled.has(r.id)));
    if (ready.length) {
      for (const id of ready) {
        order.push(byId.get(id)!);
        pending.delete(id);
      }
      continue;
    }
    // 순환: NULL이 되는 외래키 하나를 끊는다. 없으면 남은 테이블은 만들 수 없다
    const cut = [...pending].flatMap((id) => fksOf(byId.get(id)!).filter((r) => r.toTableId !== id && pending.has(r.toTableId) && !nulled.has(r.id) && !required(byId.get(id)!, r)))[0];
    if (cut) {
      nulled.add(cut.id);
      warnings.push(`${byId.get(cut.fromTableId)!.name} → ${byId.get(cut.toTableId)!.name}: 서로 가리키는 외래키라 이번에는 NULL로 둡니다`);
      continue;
    }
    // 순환 안에 있는 테이블과, 그 순환 테이블을 부모로 가져 못 넣는 테이블을 나눠 알린다
    const parentsOf = (id: string) => fksOf(byId.get(id)!).filter((r) => r.toTableId !== id && pending.has(r.toTableId) && !nulled.has(r.id) && required(byId.get(id)!, r)).map((r) => r.toTableId);
    const inCycle = (id: string) => {
      const seenIds = new Set<string>();
      const stack = [...parentsOf(id)];
      while (stack.length) {
        const next = stack.pop()!;
        if (next === id) return true;
        if (seenIds.has(next)) continue;
        seenIds.add(next);
        stack.push(...parentsOf(next));
      }
      return false;
    };
    for (const id of pending) {
      const cycle = inCycle(id);
      const parent = parentsOf(id).map((p) => byId.get(p)!.name)[0];
      skipped.push({ name: byId.get(id)!.name, reason: cycle ? 'NOT NULL 외래키가 서로를 가리켜(순환) 먼저 넣을 수 있는 쪽이 없습니다' : `부모 테이블 ${parent}을(를) 순환 때문에 넣을 수 없습니다` });
    }
    break;
  }

  const rowsOf = new Map<string, Map<string, unknown>[]>();
  const statements: string[] = [];
  const tables: SeedResult['tables'] = [];
  const after: string[] = []; // 자동 증가 번호 맞추기 (PostgreSQL·Oracle)
  const byteLimitTypes = dialect.seed.byteLengthTypes;

  for (const table of order) {
    const want = rowsFor(table);
    if (!want) continue;
    const enumValues = new Map<string, string[] | null>();
    for (const c of table.columns) {
      const e = enumOfType(schema.enums, c.type);
      const base = baseOf(c);
      enumValues.set(c.id, e ? e.values : (base === 'ENUM' || base === 'SET') ? parseEnumValueList(c.length) : null);
    }
    const kinds = new Map(table.columns.map((c) => [c.id, kindOf(c, enumValues.get(c.id) ?? null)]));
    const rules = checkRules(table, warnings);
    const fks = fksOf(table).filter((r) => !nulled.has(r.id) && (r.toTableId === table.id || rowsOf.has(r.toTableId)));
    const fkColumns = new Set(fksOf(table).flatMap((r) => r.fromColumnIds));
    // 넣을 컬럼: 계산 컬럼 빼고, 모르는 타입은 기본값이 있거나 NULL이 되면 뺀다
    const columns = table.columns.filter((c) => {
      if (c.generated?.expression.trim()) return false;
      if (kinds.get(c.id) === 'unknown' && !fkColumns.has(c.id)) {
        if (c.defaultValue !== null || (c.nullable && !c.primaryKey)) return false;
        warnings.push(`${table.name}.${c.name}: ${c.type} 타입 값은 만들 줄 몰라 NULL을 넣습니다`);
      }
      return true;
    });
    // 부모가 없어 못 채우는 NOT NULL 외래키
    const missingParent = fksOf(table).find((r) => !fks.includes(r) && !nulled.has(r.id) && required(table, r));
    if (missingParent) {
      skipped.push({ name: table.name, reason: `${byId.get(missingParent.toTableId)!.name}에 넣은 행이 없어 외래키를 채울 수 없습니다` });
      continue;
    }
    const uniqueKeys = [
      table.columns.filter((c) => c.primaryKey).map((c) => c.id),
      ...table.columns.filter((c) => c.unique && !c.primaryKey).map((c) => [c.id]),
      ...table.indexes.filter((i) => i.unique && !i.expression?.trim() && !i.where?.trim() && i.columnIds.length).map((i) => i.columnIds),
    ].filter((k) => k.length);
    const seen = uniqueKeys.map(() => new Set<string>());
    const rows: Map<string, unknown>[] = [];
    rowsOf.set(table.id, rows);
    // 컬럼마다 값 만드는 방법을 한 번만 정한다 (행마다 이름 규칙을 다시 보지 않게)
    const singleUnique = new Set(uniqueKeys.filter((k) => k.length === 1).map((k) => k[0]!));
    const ctxOf = new Map(
      columns.map((c) => [
        c.id,
        {
          start,
          values: enumValues.get(c.id) ?? null,
          rule: rules.get(c.id),
          byteLimit: Boolean(byteLimitTypes?.test(baseOf(c))),
          hint: nameHint(c),
          text: kinds.get(c.id) === 'string' ? textMaker(c) : undefined,
          uniqueText: singleUnique.has(c.id) && !fkColumns.has(c.id),
        },
      ]),
    );
    // 겹치는 값이 연달아 나오면(값이 몇 개뿐인 UNIQUE, 부모 행보다 많은 1:1 등) 더 만들 수 없는 것으로 보고 멈춘다
    let misses = 0;
    while (rows.length < want && misses < 50) {
      const i = rows.length;
      const row = new Map<string, unknown>();
      for (const c of columns) {
        if (fkColumns.has(c.id)) continue;
        const nullable = c.nullable && !c.primaryKey && !c.unique;
        row.set(c.id, nullable && c.defaultValue === null && rng.next() < 0.1 ? null : makeValue(c, kinds.get(c.id)!, i, rng, ctxOf.get(c.id)!));
      }
      for (const c of columns) if (fkColumns.has(c.id)) row.set(c.id, null);
      for (const r of fks) {
        // 자기 자신을 가리키면 앞에 만든 행(또는 자기 자신)에서 고른다
        const self = r.toTableId === table.id;
        const pool = self ? [...rows, row] : rowsOf.get(r.toTableId)!;
        const optional = !required(table, r);
        if (!pool.length || (optional && rng.next() < (self ? 0.5 : 0.1))) continue;
        const parent = self && optional && !rows.length ? null : rng.pick(pool);
        if (!parent) continue;
        r.fromColumnIds.forEach((cid, k) => row.set(cid, parent.get(r.toColumnIds[k]!) ?? null));
      }
      const keys = uniqueKeys.map((k) => (k.some((id) => row.get(id) === null || row.get(id) === undefined) ? null : JSON.stringify(k.map((id) => row.get(id)))));
      if (keys.some((key, k) => key !== null && seen[k]!.has(key))) {
        misses++;
        continue;
      }
      misses = 0;
      keys.forEach((key, k) => key !== null && seen[k]!.add(key));
      rows.push(row);
    }
    if (rows.length < want) warnings.push(`${table.name}: 겹치지 않는 값(기본키·UNIQUE)을 ${want}행만큼 만들 수 없어 ${rows.length}행만 만듭니다 (부모 행 수를 늘려 보세요)`);
    if (!rows.length) continue;

    const q = (name: string) => dialect.quote(name);
    const head = `INSERT INTO ${q(table.name)} (${columns.map((c) => q(c.name)).join(', ')})`;
    const values = rows.map((row) => `(${columns.map((c) => render(dialect, c, kinds.get(c.id)!, row.get(c.id))).join(', ')})`);
    const identity = columns.filter((c) => c.autoIncrement);
    const wrap = identity.length ? dialect.seed.identityInsert?.(table.name) : undefined;
    if (wrap) statements.push(wrap.before);
    if (!dialect.seed.multiRow) for (const v of values) statements.push(`${head} VALUES ${v}`);
    else for (let k = 0; k < values.length; k += 100) statements.push(`${head} VALUES\n  ${values.slice(k, k + 100).join(',\n  ')}`);
    if (wrap) statements.push(wrap.after);
    // 번호를 직접 넣었으니 자동 증가가 다음 번호부터 이어지게
    for (const c of identity) {
      const reset = dialect.seed.resetIdentity?.(table.name, c.name);
      if (reset) after.push(reset);
    }
    tables.push({ id: table.id, name: table.name, rows: rows.length });
  }
  statements.push(...after);
  return { statements, tables, added, skipped, warnings };
}

/** 실행할 수 있는 SQL 파일 내용 (문장마다 ;) */
export function seedScript(result: SeedResult): string {
  if (!result.statements.length) return '';
  // 테이블이 많아도 한 줄이 끝없이 길어지지 않게 개수만 (테이블별 행 수는 INSERT에 있다)
  const total = result.tables.reduce((n, t) => n + t.rows, 0);
  const names = result.tables.slice(0, 8).map((t) => t.name).join(', ') + (result.tables.length > 8 ? ` 외 ${result.tables.length - 8}개` : '');
  const head = `-- 테스트 데이터: ${result.tables.length}개 테이블 · ${total}행 (${names})`;
  return [head, ...result.statements.map((s) => `${s};`)].join('\n\n');
}
