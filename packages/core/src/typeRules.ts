// 컬럼 타입 검사: DB에 실행하면 실패하거나 의도와 다르게 만들어지는 타입·길이·자동 증가·기본값 조합을 DB별로 찾는다.
// 규칙은 아래 RULES 표에 한 줄씩 있다. 새 규칙은 표에 추가하면 설계 검사·편집 창·DB 내보내기 경고에 함께 쓰인다.

import { getDialect, type Dialect, type DialectId } from './dialects';
import type { Column, Table } from './model';

export type TypeIssueSeverity = 'error' | 'warning' | 'info';
/** 문제가 있는 편집 칸 (편집 창에서 표시할 곳) */
export type TypeIssueField = 'type' | 'length' | 'autoIncrement' | 'defaultValue' | 'onUpdate' | 'unique';

export interface TypeIssue {
  code: string;
  /** error: DB에서 실패, warning: 실패할 수 있거나 의도와 다를 수 있음, info: DB가 무시함 */
  severity: TypeIssueSeverity;
  field: TypeIssueField;
  message: string;
  /** 바로 고치는 방법 */
  fix?: { label: string; patch: Partial<Column> };
}

export interface TableTypeIssue extends TypeIssue {
  columnId: string;
  columnName: string;
}

/** 규칙이 보는 컬럼 정보. 타입은 이 DB로 실제 만들어지는 형태(renderType)로 본다 */
interface Ctx {
  dialect: DialectId;
  column: Column;
  /** 괄호 앞 타입 이름 (예: DATETIME, NVARCHAR, NUMBER) */
  base: string;
  /** 괄호 안 (예: "255", "10,2", "MAX"). 없으면 '' */
  args: string;
  /** 실제로 만들어지는 타입 (예: DATETIME(255)) */
  rendered: string;
}

interface Rule {
  code: string;
  dialects: DialectId[] | 'all';
  /** 타입·길이를 바꿀 때 편집 창이 이 규칙의 fix를 자동으로 적용한다 */
  autoFix?: boolean;
  check(ctx: Ctx): Omit<TypeIssue, 'code'> | undefined;
}

const MY: DialectId[] = ['mysql', 'mariadb'];
const ENUM_LIKE = new Set(['ENUM', 'SET']);

const INTEGER_TYPES: Record<DialectId, Set<string>> = {
  mysql: new Set(['TINYINT', 'SMALLINT', 'MEDIUMINT', 'INT', 'INTEGER', 'BIGINT']),
  mariadb: new Set(['TINYINT', 'SMALLINT', 'MEDIUMINT', 'INT', 'INTEGER', 'BIGINT']),
  postgresql: new Set(['SMALLINT', 'INTEGER', 'BIGINT']),
  mssql: new Set(['TINYINT', 'SMALLINT', 'INT', 'BIGINT']),
  oracle: new Set(['INTEGER']),
};
const NUMERIC_TYPES = new Set([
  'TINYINT', 'SMALLINT', 'MEDIUMINT', 'INT', 'INTEGER', 'BIGINT', 'DECIMAL', 'NUMERIC', 'NUMBER',
  'FLOAT', 'DOUBLE', 'REAL', 'DOUBLE PRECISION', 'BINARY_DOUBLE', 'BINARY_FLOAT', 'MONEY',
]);
/** 소수 초 자릿수(0~6)를 괄호에 쓰는 날짜·시간 타입 */
const FRACTION_TYPES: Partial<Record<DialectId, Set<string>>> = {
  mysql: new Set(['DATETIME', 'TIMESTAMP', 'TIME']),
  mariadb: new Set(['DATETIME', 'TIMESTAMP', 'TIME']),
  postgresql: new Set(['TIMESTAMP', 'TIMESTAMPTZ', 'TIME', 'TIMETZ']),
};
/** 괄호(길이)를 쓰면 문법 오류인 MySQL 타입 */
const MYSQL_NO_LENGTH = new Set(['DATE', 'JSON', 'TINYTEXT', 'MEDIUMTEXT', 'LONGTEXT', 'TINYBLOB', 'MEDIUMBLOB', 'LONGBLOB', 'GEOMETRY', 'POINT', 'LINESTRING', 'POLYGON']);
const MYSQL_LOB = /^(TINY|MEDIUM|LONG)?(TEXT|BLOB)$|^JSON$|^GEOMETRY$/;

/** 문자·바이너리 타입별 최대 길이. max가 'MAX'면 그보다 길면 MAX로 바꾸게 한다 */
const STRING_LIMITS: Record<DialectId, Record<string, { max: number; soft?: number; useMax?: boolean }>> = {
  // utf8mb4 기준 (한 글자 최대 4바이트, 행 최대 65535바이트)
  mysql: { VARCHAR: { max: 16383 }, CHAR: { max: 255 }, VARBINARY: { max: 65535 }, BINARY: { max: 255 } },
  mariadb: { VARCHAR: { max: 16383 }, CHAR: { max: 255 }, VARBINARY: { max: 65535 }, BINARY: { max: 255 } },
  postgresql: { VARCHAR: { max: 10485760 }, CHAR: { max: 10485760 } },
  // 기본 설정은 4000바이트, MAX_STRING_SIZE=EXTENDED면 32767바이트
  oracle: { VARCHAR2: { max: 32767, soft: 4000 }, NVARCHAR2: { max: 16383, soft: 2000 }, CHAR: { max: 2000 }, NCHAR: { max: 1000 }, RAW: { max: 32767, soft: 2000 } },
  mssql: { VARCHAR: { max: 8000, useMax: true }, VARBINARY: { max: 8000, useMax: true }, NVARCHAR: { max: 4000, useMax: true }, CHAR: { max: 8000 }, BINARY: { max: 8000 }, NCHAR: { max: 4000 } },
};
/** DECIMAL 계열 최대 자릿수(p)·소수 자릿수(s) */
const DECIMAL_LIMITS: Partial<Record<DialectId, { types: Set<string>; p: number; s: number; sWithinP: boolean; minS?: number }>> = {
  mysql: { types: new Set(['DECIMAL', 'NUMERIC']), p: 65, s: 30, sWithinP: true },
  mariadb: { types: new Set(['DECIMAL', 'NUMERIC']), p: 65, s: 38, sWithinP: true },
  postgresql: { types: new Set(['NUMERIC', 'DECIMAL']), p: 1000, s: 1000, sWithinP: false, minS: -1000 },
  mssql: { types: new Set(['DECIMAL', 'NUMERIC']), p: 38, s: 38, sWithinP: true },
  oracle: { types: new Set(['NUMBER']), p: 38, s: 127, sWithinP: false, minS: -84 },
};

const isInt = (v: string) => /^\d+$/.test(v.trim());
const CURRENT_TIME = /^(CURRENT_TIMESTAMP|NOW|LOCALTIMESTAMP)\s*(\(\s*(\d*)\s*\))?$/i;
/** CURRENT_TIMESTAMP(3) → 3, CURRENT_TIMESTAMP → 0, 시각 함수가 아니면 null */
function timePrecision(value: string | null | undefined): number | null {
  const m = value?.trim().match(CURRENT_TIME);
  if (!m) return null;
  return m[3] ? Number(m[3]) : 0;
}
const currentTimestamp = (fsp: number) => (fsp > 0 ? `CURRENT_TIMESTAMP(${fsp})` : 'CURRENT_TIMESTAMP');
/** 날짜 컬럼의 소수 초 자릿수 (괄호가 없으면 0) */
const fspOf = (ctx: Ctx) => (isInt(ctx.args) ? Number(ctx.args) : 0);

function canAutoIncrementType(ctx: Ctx): boolean {
  const { dialect, base, args } = ctx;
  if (INTEGER_TYPES[dialect].has(base)) return true;
  const scale = Number(args.split(',')[1] ?? 0);
  if (dialect === 'mssql') return (base === 'DECIMAL' || base === 'NUMERIC') && scale === 0;
  if (dialect === 'oracle') return base === 'NUMBER' && scale === 0;
  return false;
}

const RULES: Rule[] = [
  // ── 자동 증가 ────────────────────────────────────────────
  {
    code: 'auto-increment-type',
    dialects: 'all',
    check(ctx) {
      const { column, dialect, base } = ctx;
      if (!column.autoIncrement || column.generated?.expression.trim() || canAutoIncrementType(ctx)) return undefined;
      // MySQL은 FLOAT·DOUBLE의 AUTO_INCREMENT를 아직 받지만 쓰지 않을 기능(deprecated)이다
      const floatOk = MY.includes(dialect) && (base === 'FLOAT' || base === 'DOUBLE');
      const what = dialect === 'mysql' || dialect === 'mariadb' ? 'AUTO_INCREMENT' : dialect === 'mssql' ? 'IDENTITY' : 'IDENTITY(자동 증가)';
      return {
        severity: floatOk ? 'warning' : 'error',
        field: 'autoIncrement',
        message: floatOk
          ? `${column.name}: ${base}의 ${what}는 곧 없어질 기능입니다. 정수 타입(BIGINT 등)을 쓰세요`
          : `${column.name}: ${what}는 정수 타입에만 쓸 수 있습니다 (지금 ${ctx.rendered})`,
        fix: { label: 'BIGINT로', patch: { type: 'BIGINT', length: '', defaultValue: null } },
      };
    },
  },
  {
    code: 'auto-increment-default',
    dialects: MY,
    check({ column }) {
      if (!column.autoIncrement || column.defaultValue === null || !column.defaultValue.trim()) return undefined;
      return { severity: 'error', field: 'defaultValue', message: `${column.name}: 자동 증가 컬럼에는 기본값을 둘 수 없습니다`, fix: { label: '기본값 지우기', patch: { defaultValue: null } } };
    },
  },
  {
    code: 'auto-increment-default-ignored',
    dialects: ['postgresql', 'oracle', 'mssql'],
    check({ column }) {
      if (!column.autoIncrement || column.defaultValue === null || !column.defaultValue.trim()) return undefined;
      return { severity: 'info', field: 'defaultValue', message: `${column.name}: 자동 증가 컬럼이라 기본값 ${column.defaultValue}은(는) 쓰지 않습니다`, fix: { label: '기본값 지우기', patch: { defaultValue: null } } };
    },
  },

  // ── 날짜·시간 자릿수 ─────────────────────────────────────
  {
    code: 'time-precision',
    dialects: ['mysql', 'mariadb', 'postgresql'],
    autoFix: true,
    check(ctx) {
      const types = FRACTION_TYPES[ctx.dialect];
      if (!types?.has(ctx.base) || !ctx.args) return undefined;
      if (isInt(ctx.args) && Number(ctx.args) <= 6) return undefined;
      return {
        severity: 'error',
        field: 'length',
        message: `${ctx.column.name}: ${ctx.base}의 괄호 숫자는 초 아래 자릿수라 0~6만 됩니다 (지금 ${ctx.args})`,
        fix: { label: '길이 지우기', patch: { length: '' } },
      };
    },
  },

  // ── 길이 ────────────────────────────────────────────────
  {
    code: 'length-not-allowed',
    dialects: MY,
    autoFix: true,
    check(ctx) {
      if (!ctx.args || !MYSQL_NO_LENGTH.has(ctx.base)) return undefined;
      return { severity: 'error', field: 'length', message: `${ctx.column.name}: ${ctx.base}에는 길이를 쓸 수 없습니다 (지금 ${ctx.args})`, fix: { label: '길이 지우기', patch: { length: '' } } };
    },
  },
  {
    code: 'length-ignored',
    dialects: ['postgresql', 'oracle', 'mssql'],
    autoFix: true,
    check(ctx) {
      const length = ctx.column.length.replace(/\s+/g, '').toUpperCase();
      if (!length || ENUM_LIKE.has(ctx.base) || ctx.column.generated?.expression.trim()) return undefined;
      if (ctx.args.replace(/\s+/g, '').toUpperCase() === (length === '-1' ? 'MAX' : length)) return undefined;
      return {
        severity: 'info',
        field: 'length',
        message: `${ctx.column.name}: ${getDialect(ctx.dialect).label}에서는 ${ctx.column.type}의 길이 ${ctx.column.length}을(를) 쓰지 않고 ${ctx.rendered}(으)로 만듭니다`,
        fix: { label: '길이 지우기', patch: { length: '' } },
      };
    },
  },
  {
    code: 'varchar-length-required',
    dialects: MY,
    autoFix: true,
    check(ctx) {
      if (ctx.base !== 'VARCHAR' && ctx.base !== 'VARBINARY') return undefined;
      if (ctx.args) return undefined;
      return { severity: 'error', field: 'length', message: `${ctx.column.name}: ${ctx.base}는 길이가 꼭 있어야 합니다`, fix: { label: '길이 255', patch: { length: '255' } } };
    },
  },
  {
    code: 'string-length',
    dialects: 'all',
    check(ctx) {
      const limit = STRING_LIMITS[ctx.dialect][ctx.base];
      if (!limit || !ctx.args) return undefined;
      const args = ctx.args.trim().toUpperCase();
      if (args === 'MAX' && limit.useMax) return undefined;
      // Oracle: VARCHAR2(100 CHAR)
      const n = ctx.dialect === 'oracle' ? args.replace(/\s*(CHAR|BYTE)$/, '') : args;
      if (!isInt(n) || Number(n) < 1) {
        return { severity: 'error', field: 'length', message: `${ctx.column.name}: ${ctx.base}의 길이는 1 이상의 숫자여야 합니다 (지금 ${ctx.args})` };
      }
      const len = Number(n);
      if (len > limit.max) {
        const fix = limit.useMax ? { label: 'MAX로', patch: { length: 'MAX' } } : MY.includes(ctx.dialect) && ctx.base === 'VARCHAR' ? { label: 'TEXT로', patch: { type: 'TEXT', length: '' } } : { label: `${limit.max}로`, patch: { length: String(limit.max) } };
        return { severity: 'error', field: 'length', message: `${ctx.column.name}: ${ctx.base}의 최대 길이는 ${limit.max}입니다 (지금 ${len})`, fix };
      }
      if (limit.soft && len > limit.soft) {
        return { severity: 'warning', field: 'length', message: `${ctx.column.name}: ${ctx.base}(${len})는 DB 설정이 MAX_STRING_SIZE=EXTENDED일 때만 됩니다 (기본 최대 ${limit.soft})` };
      }
      return undefined;
    },
  },
  {
    code: 'integer-display-width',
    dialects: MY,
    check(ctx) {
      if (!INTEGER_TYPES[ctx.dialect].has(ctx.base) || !ctx.args) return undefined;
      if (isInt(ctx.args) && Number(ctx.args) <= 255) return undefined;
      return { severity: 'error', field: 'length', message: `${ctx.column.name}: ${ctx.base}의 괄호 숫자(표시 폭)는 0~255만 됩니다 (지금 ${ctx.args}). 정수 타입은 길이를 비워 두면 됩니다`, fix: { label: '길이 지우기', patch: { length: '' } } };
    },
  },
  {
    code: 'decimal-precision',
    dialects: 'all',
    check(ctx) {
      const limit = DECIMAL_LIMITS[ctx.dialect];
      if (!limit?.types.has(ctx.base) || !ctx.args) return undefined;
      const [pText, sText] = ctx.args.split(',').map((v) => v.trim());
      const signed = (v: string) => /^-?\d+$/.test(v);
      if (!isInt(pText ?? '') || (sText !== undefined && !signed(sText))) {
        return { severity: 'error', field: 'length', message: `${ctx.column.name}: ${ctx.base}의 길이는 "전체 자릿수,소수 자릿수" 형식입니다 (예: 10,2. 지금 ${ctx.args})` };
      }
      const p = Number(pText);
      const s = sText === undefined ? 0 : Number(sText);
      const problems: string[] = [];
      if (p < 1 || p > limit.p) problems.push(`전체 자릿수는 1~${limit.p}`);
      if (s > limit.s || s < (limit.minS ?? 0)) problems.push(`소수 자릿수는 ${limit.minS ?? 0}~${limit.s}`);
      if (limit.sWithinP && s > p) problems.push('소수 자릿수는 전체 자릿수보다 클 수 없음');
      if (!problems.length) return undefined;
      return { severity: 'error', field: 'length', message: `${ctx.column.name}: ${ctx.base}(${ctx.args}) — ${problems.join(', ')}` };
    },
  },

  // ── 수정 시 값 (ON UPDATE CURRENT_TIMESTAMP) ─────────────
  {
    code: 'on-update-type',
    dialects: MY,
    autoFix: true,
    check(ctx) {
      if (!ctx.column.onUpdate?.trim()) return undefined;
      if (ctx.base === 'DATETIME' || ctx.base === 'TIMESTAMP') return undefined;
      return { severity: 'error', field: 'onUpdate', message: `${ctx.column.name}: ON UPDATE ${ctx.column.onUpdate}는 DATETIME·TIMESTAMP에만 쓸 수 있습니다`, fix: { label: 'ON UPDATE 끄기', patch: { onUpdate: undefined } } };
    },
  },
  {
    code: 'on-update-precision',
    dialects: MY,
    autoFix: true,
    check(ctx) {
      if (ctx.base !== 'DATETIME' && ctx.base !== 'TIMESTAMP') return undefined;
      const p = timePrecision(ctx.column.onUpdate);
      const fsp = fspOf(ctx);
      if (p === null || p === fsp || fsp > 6) return undefined;
      return {
        severity: 'error',
        field: 'onUpdate',
        message: `${ctx.column.name}: ON UPDATE ${ctx.column.onUpdate}의 자릿수가 컬럼(${ctx.rendered})과 같아야 합니다`,
        fix: { label: `${currentTimestamp(fsp)}로`, patch: { onUpdate: currentTimestamp(fsp) } },
      };
    },
  },
  {
    code: 'on-update-created',
    dialects: MY,
    check({ column }) {
      if (!column.onUpdate?.trim()) return undefined;
      if (!/^(created?|reg|regist|insert)(_|at|date|dt|$)/i.test(column.name) && !/생성|등록/.test(column.logicalName)) return undefined;
      return {
        severity: 'warning',
        field: 'onUpdate',
        message: `${column.name}: 생성(등록) 시각인데 ON UPDATE가 켜져 있어 행을 고칠 때마다 값이 바뀝니다. 생성 시각이면 기본값 CURRENT_TIMESTAMP만 두세요`,
        fix: { label: 'ON UPDATE 끄기', patch: { onUpdate: undefined } },
      };
    },
  },
  {
    code: 'on-update-ignored',
    dialects: ['postgresql', 'oracle', 'mssql'],
    check(ctx) {
      if (!ctx.column.onUpdate?.trim()) return undefined;
      return { severity: 'info', field: 'onUpdate', message: `${ctx.column.name}: ON UPDATE ${ctx.column.onUpdate}는 MySQL·MariaDB 기능이라 ${getDialect(ctx.dialect).label}에서는 만들지 않습니다 (트리거가 필요)`, fix: { label: 'ON UPDATE 끄기', patch: { onUpdate: undefined } } };
    },
  },

  // ── 기본값 ──────────────────────────────────────────────
  {
    code: 'default-time-type',
    dialects: MY,
    check(ctx) {
      const p = timePrecision(ctx.column.defaultValue);
      if (p === null || ctx.column.autoIncrement) return undefined;
      if (ctx.base !== 'DATETIME' && ctx.base !== 'TIMESTAMP') {
        return { severity: 'error', field: 'defaultValue', message: `${ctx.column.name}: 기본값 ${ctx.column.defaultValue}는 DATETIME·TIMESTAMP에만 쓸 수 있습니다 (지금 ${ctx.rendered})` };
      }
      const fsp = fspOf(ctx);
      if (p === fsp || fsp > 6) return undefined;
      return {
        severity: 'error',
        field: 'defaultValue',
        message: `${ctx.column.name}: 기본값 ${ctx.column.defaultValue}의 자릿수가 컬럼(${ctx.rendered})과 같아야 합니다`,
        fix: { label: `${currentTimestamp(fsp)}로`, patch: { defaultValue: currentTimestamp(fsp) } },
      };
    },
  },
  {
    code: 'default-on-lob',
    dialects: ['mysql'],
    check(ctx) {
      const v = ctx.column.defaultValue?.trim();
      if (!v || /^null$/i.test(v) || v.startsWith('(') || !MYSQL_LOB.test(ctx.base)) return undefined;
      return {
        severity: 'error',
        field: 'defaultValue',
        message: `${ctx.column.name}: MySQL의 ${ctx.base}에는 값 그대로의 기본값을 둘 수 없습니다. 괄호로 감싼 식만 됩니다 (MySQL 8.0.13 이상)`,
        fix: { label: `(${v})로`, patch: { defaultValue: `(${v})` } },
      };
    },
  },
  {
    code: 'default-not-number',
    dialects: 'all',
    check(ctx) {
      const v = ctx.column.defaultValue?.trim();
      if (!v || ctx.column.autoIncrement || !NUMERIC_TYPES.has(ctx.base)) return undefined;
      if (/^null$|^true$|^false$/i.test(v)) return undefined;
      if (/^'?[-+]?(\d+(\.\d*)?|\.\d+)'?$/.test(v)) return undefined;
      // 함수·식(예: nextval('seq'), (1 + 2))은 DB가 판단한다
      if (/^\(|^[A-Za-z_][\w.]*\s*\(/.test(v)) return undefined;
      return { severity: 'warning', field: 'defaultValue', message: `${ctx.column.name}: 숫자 타입(${ctx.rendered})인데 기본값 ${v}이(가) 숫자가 아닙니다` };
    },
  },
  {
    code: 'default-boolean',
    dialects: ['postgresql'],
    check(ctx) {
      const v = ctx.column.defaultValue?.trim().replace(/^'|'$/g, '');
      if (ctx.base !== 'BOOLEAN' || (v !== '0' && v !== '1')) return undefined;
      const value = v === '1' ? 'TRUE' : 'FALSE';
      return { severity: 'error', field: 'defaultValue', message: `${ctx.column.name}: PostgreSQL BOOLEAN의 기본값은 TRUE/FALSE로 씁니다 (지금 ${ctx.column.defaultValue})`, fix: { label: `${value}로`, patch: { defaultValue: value } } };
    },
  },
];

function parseRendered(rendered: string): { base: string; args: string } {
  const m = rendered.trim().toUpperCase().match(/^([^(]+?)\s*(?:\(([^)]*)\))?(?:\s+.*)?$/);
  if (!m) return { base: rendered.trim().toUpperCase(), args: '' };
  // DECIMAL UNSIGNED처럼 괄호 없이 뒤에 붙은 말은 타입 이름에서 뺀다
  const base = m[1]!.replace(/\s+(UNSIGNED|ZEROFILL)\b.*$/, '').trim();
  return { base, args: (m[2] ?? '').trim() };
}

const asDialect = (dialect: Dialect | DialectId | string): Dialect => (typeof dialect === 'string' ? getDialect((dialect || 'mysql') as DialectId) : dialect);

function contextOf(dialect: Dialect, column: Column): Ctx {
  const rendered = dialect.renderType(column);
  return { dialect: dialect.id, column, rendered, ...parseRendered(rendered) };
}

function runRules(dialect: Dialect, column: Column, only?: (rule: Rule) => boolean): (TypeIssue & { autoFix?: boolean })[] {
  // SQL Server 계산 컬럼은 타입을 DB가 정한다
  if (column.generated?.expression.trim() && dialect.generatedSupport?.typed === false) return [];
  const ctx = contextOf(dialect, column);
  if (ENUM_LIKE.has(ctx.base)) return [];
  const issues: (TypeIssue & { autoFix?: boolean })[] = [];
  for (const rule of RULES) {
    if (rule.dialects !== 'all' && !rule.dialects.includes(dialect.id)) continue;
    if (only && !only(rule)) continue;
    const found = rule.check(ctx);
    if (found) issues.push({ code: rule.code, ...found, autoFix: rule.autoFix });
  }
  return issues;
}

/** 컬럼 하나의 타입 문제 */
export function columnTypeIssues(dialect: Dialect | DialectId | string, column: Column): TypeIssue[] {
  return runRules(asDialect(dialect), column).map(({ autoFix: _autoFix, ...issue }) => issue);
}

/** 테이블의 타입 문제 (컬럼별 + 테이블 단위: 자동 증가 컬럼 개수, MySQL 자동 증가 컬럼의 인덱스) */
export function tableTypeIssues(dialect: Dialect | DialectId | string, table: Table): TableTypeIssue[] {
  const d = asDialect(dialect);
  const issues: TableTypeIssue[] = table.columns.flatMap((c) => columnTypeIssues(d, c).map((i) => ({ ...i, columnId: c.id, columnName: c.name })));
  const auto = table.columns.filter((c) => c.autoIncrement && !c.generated?.expression.trim());
  if (auto.length > 1 && d.id !== 'postgresql') {
    for (const c of auto.slice(1)) {
      issues.push({
        code: 'auto-increment-multiple', severity: 'error', field: 'autoIncrement', columnId: c.id, columnName: c.name,
        message: `${table.name}: ${d.label}는 자동 증가 컬럼을 테이블에 하나만 둘 수 있습니다 (${auto.map((x) => x.name).join(', ')})`,
        fix: { label: '자동 증가 끄기', patch: { autoIncrement: false } },
      });
    }
  }
  if (d.id === 'mysql' || d.id === 'mariadb') {
    const row = mysqlRowBytes(table);
    if (row.bytes > 65535 && row.widest) {
      issues.push({
        code: 'row-size', severity: 'error', field: 'length', columnId: row.widest.id, columnName: row.widest.name,
        message: `${table.name}: 한 행의 최대 크기 65535바이트를 넘습니다 (약 ${row.bytes}바이트, utf8mb4는 한 글자 4바이트). 긴 VARCHAR를 TEXT로 바꾸세요 (가장 긴 것: ${row.widest.name})`,
        fix: { label: `${row.widest.name}을(를) TEXT로`, patch: { type: 'TEXT', length: '' } },
      });
    }
    const pkFirst = table.columns.find((c) => c.primaryKey)?.id;
    for (const c of auto) {
      const keyed = pkFirst === c.id || c.unique || table.indexes.some((i) => !i.expression?.trim() && i.columnIds[0] === c.id);
      if (keyed) continue;
      issues.push({
        code: 'auto-increment-key', severity: 'error', field: 'autoIncrement', columnId: c.id, columnName: c.name,
        message: `${c.name}: AUTO_INCREMENT 컬럼은 기본키(첫 번째 컬럼)이거나 인덱스의 첫 번째 컬럼이어야 합니다`,
        fix: { label: 'UNIQUE로', patch: { unique: true } },
      });
    }
  }
  return issues;
}

/** MySQL 한 행 크기(바이트) 어림값. TEXT·BLOB은 행 밖에 저장되어 몇 바이트만 센다 */
function mysqlRowBytes(table: Table): { bytes: number; widest?: Column } {
  const FIXED: Record<string, number> = { TINYINT: 1, SMALLINT: 2, MEDIUMINT: 3, INT: 4, INTEGER: 4, BIGINT: 8, FLOAT: 4, DOUBLE: 8, DATE: 3, TIME: 6, DATETIME: 8, TIMESTAMP: 7, YEAR: 1, BOOLEAN: 1, BOOL: 1 };
  let bytes = Math.ceil(table.columns.filter((c) => c.nullable && !c.primaryKey).length / 8);
  let widest: Column | undefined;
  let widestBytes = 0;
  for (const c of table.columns) {
    if (c.generated?.expression.trim() && !c.generated.stored) continue;
    const { base, args } = parseRendered(mysqlRenderType(c));
    const n = Number.parseInt(args, 10) || 0;
    let size: number;
    if (base === 'VARCHAR') size = n * 4 + (n * 4 > 255 ? 2 : 1);
    else if (base === 'CHAR') size = n * 4;
    else if (base === 'VARBINARY') size = n + (n > 255 ? 2 : 1);
    else if (base === 'BINARY') size = n;
    else if (base === 'DECIMAL' || base === 'NUMERIC') size = Math.ceil((n || 10) / 2) + 1;
    else if (MYSQL_LOB.test(base)) size = 12;
    else size = FIXED[base] ?? 8;
    bytes += size;
    if ((base === 'VARCHAR' || base === 'CHAR') && size > widestBytes) {
      widest = c;
      widestBytes = size;
    }
  }
  return { bytes, widest };
}
const mysqlRenderType = (c: Column) => getDialect('mysql').renderType(c);

/** 이 타입으로 자동 증가를 켤 수 있는지 */
export function canAutoIncrement(dialect: Dialect | DialectId | string, column: Column): boolean {
  const d = asDialect(dialect);
  return canAutoIncrementType(contextOf(d, column));
}

/**
 * 편집 창에서 컬럼을 고칠 때 함께 바로잡을 것.
 * 이 수정으로 새로 생긴 문제 중 자동으로 고쳐도 되는 것(타입을 바꿔 남은 길이, 날짜 자릿수, ON UPDATE 자릿수 등)을 고친다.
 * 예) VARCHAR(255)를 DATETIME으로 바꾸면 길이 255를 지운다
 */
export function autoFixColumnPatch(dialect: Dialect | DialectId | string, column: Column, patch: Partial<Column>): { patch: Partial<Column>; notes: string[] } {
  const d = asDialect(dialect);
  const before = new Set(runRules(d, column).map((i) => i.code));
  let next: Partial<Column> = { ...patch };
  const notes: string[] = [];
  // 정수가 아닌 타입으로 바꾸면 자동 증가를 끈다 (켜 두면 DB에서 실패)
  if (patch.type !== undefined && column.autoIncrement && patch.autoIncrement === undefined && !canAutoIncrement(d, { ...column, ...next })) {
    next.autoIncrement = false;
    notes.push(`${column.name}: ${patch.type}는 자동 증가를 쓸 수 없어 자동 증가를 껐습니다`);
  }
  for (let round = 0; round < 4; round++) {
    const fixable = runRules(d, { ...column, ...next }, (r) => Boolean(r.autoFix)).filter((i) => i.fix && !before.has(i.code) && i.severity !== 'info');
    // 타입만 바꿨는데 다른 DB에서 쓰지 않게 된 길이도 지운다 (예: Oracle에서 VARCHAR2 → DATE)
    const ignored = patch.type !== undefined ? runRules(d, { ...column, ...next }, (r) => r.code === 'length-ignored').filter((i) => !before.has(i.code)) : [];
    const todo = [...fixable, ...ignored].filter((i) => !(i.field in patch) || (i.field === 'length' && patch.type !== undefined));
    if (!todo.length) break;
    for (const issue of todo) {
      next = { ...next, ...issue.fix!.patch };
      notes.push(`${issue.message} → ${issue.fix!.label}`);
    }
  }
  return { patch: next, notes };
}
