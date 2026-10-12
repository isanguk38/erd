// 컬럼 타입 검사: DB에 실행하면 실패하거나 의도와 다르게 만들어지는 타입·길이·자동 증가·기본값 조합을 찾는다.
// 검사 규칙(아래 RULES)은 공통이고, 규칙이 보는 값(아는 타입, 최대 길이, 자동 증가 타입 등)은 각 DB가 dialect.types로 준다.
// DB 이름으로 나누지 않는다 — 그 DB의 타입 정보에 칸이 없으면 그 규칙은 그 DB에 없다.
// 새 규칙은 RULES에 한 줄 추가하면 설계 검사·편집 창·DB 내보내기 경고에 함께 쓰인다.

import { getDialect, type Dialect, type DialectId } from './dialects';
import type { Column, EnumType, Table } from './model';
import { enumOfType, resolveEnumColumn } from './enums';

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
  dialect: Dialect;
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
  /** 타입·길이를 바꿀 때 편집 창이 이 규칙의 fix를 자동으로 적용한다 */
  autoFix?: boolean;
  check(ctx: Ctx): Omit<TypeIssue, 'code'> | undefined;
}

const ENUM_LIKE = new Set(['ENUM', 'SET']);
const NUMERIC_TYPES = new Set([
  'TINYINT', 'SMALLINT', 'MEDIUMINT', 'INT', 'INTEGER', 'BIGINT', 'DECIMAL', 'NUMERIC', 'NUMBER',
  'FLOAT', 'DOUBLE', 'REAL', 'DOUBLE PRECISION', 'BINARY_DOUBLE', 'BINARY_FLOAT', 'MONEY',
]);

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
  const { base, args } = ctx;
  const auto = ctx.dialect.types.autoIncrement;
  if (auto.integers.has(base)) return true;
  return auto.also?.(base, Number(args.split(',')[1] ?? 0)) ?? false;
}

const RULES: Rule[] = [
  // ── 이 DB에 없는 타입 ────────────────────────────────────
  {
    // 컬럼 타입 ENUM(...)·SET(...)은 컬럼형 ENUM 모듈이 있는 DB만
    code: 'enum-unsupported',
    check({ dialect, base }) {
      if (!ENUM_LIKE.has(base) || dialect.features.enum?.kind === 'column') return undefined;
      return {
        severity: 'error',
        field: 'type',
        message: `${base}(...) 타입은 ${dialect.label}에 없습니다. VARCHAR로 바꾸고 허용 값은 CHECK 제약으로 거세요${dialect.features.enum ? ' (또는 사용자 정의 타입을 만들어 쓰세요)' : ''}`,
        fix: { label: 'VARCHAR(50)으로', patch: { type: 'VARCHAR', length: '50' } },
      };
    },
  },
  {
    code: 'unknown-type',
    check({ dialect, base, column }) {
      const first = base.replace(/\[\]$/, '').split(/\s+/)[0] ?? '';
      if (!first || dialect.types.known.has(first) || ENUM_LIKE.has(first)) return undefined;
      // 따옴표로 감싼 타입은 직접 만든 타입 (CREATE TYPE·DOMAIN)
      if (dialect.types.quotedUserTypes && column.type.includes('"')) return undefined;
      return {
        severity: 'warning',
        field: 'type',
        message: `${first}는 ${dialect.label}에서 모르는 타입입니다. 오타이거나 다른 DB 전용 타입이면 실행할 때 실패합니다 (직접 만든 타입이면 무시하세요)`,
      };
    },
  },
  // ── 자동 증가 ────────────────────────────────────────────
  {
    code: 'auto-increment-type',
    check(ctx) {
      const { column, dialect, base } = ctx;
      if (!column.autoIncrement || column.generated?.expression.trim() || canAutoIncrementType(ctx)) return undefined;
      const auto = dialect.types.autoIncrement;
      const floatOk = Boolean(auto.floatDeprecated) && (base === 'FLOAT' || base === 'DOUBLE');
      return {
        severity: floatOk ? 'warning' : 'error',
        field: 'autoIncrement',
        message: floatOk
          ? `${column.name}: ${base}의 ${auto.label}는 곧 없어질 기능입니다. 정수 타입(BIGINT 등)을 쓰세요`
          : `${column.name}: ${auto.label}는 정수 타입에만 쓸 수 있습니다 (지금 ${ctx.rendered})`,
        fix: { label: 'BIGINT로', patch: { type: 'BIGINT', length: '', defaultValue: null } },
      };
    },
  },
  {
    code: 'auto-increment-default',
    check({ dialect, column }) {
      if (dialect.types.autoIncrement.defaultValue !== 'error' || !column.autoIncrement || column.defaultValue === null || !column.defaultValue.trim()) return undefined;
      return { severity: 'error', field: 'defaultValue', message: `${column.name}: 자동 증가 컬럼에는 기본값을 둘 수 없습니다`, fix: { label: '기본값 지우기', patch: { defaultValue: null } } };
    },
  },
  {
    code: 'auto-increment-default-ignored',
    check({ dialect, column }) {
      if (dialect.types.autoIncrement.defaultValue !== 'ignored' || !column.autoIncrement || column.defaultValue === null || !column.defaultValue.trim()) return undefined;
      return { severity: 'info', field: 'defaultValue', message: `${column.name}: 자동 증가 컬럼이라 기본값 ${column.defaultValue}은(는) 쓰지 않습니다`, fix: { label: '기본값 지우기', patch: { defaultValue: null } } };
    },
  },

  // ── 날짜·시간 자릿수 ─────────────────────────────────────
  {
    code: 'time-precision',
    autoFix: true,
    check(ctx) {
      const fraction = ctx.dialect.types.fraction;
      if (!fraction?.types.has(ctx.base) || !ctx.args) return undefined;
      if (isInt(ctx.args) && Number(ctx.args) <= 6) return undefined;
      // clamp: 실패하지 않고 6으로 줄여 만든다 (PostgreSQL — 실제 서버로 확인)
      const clamp = fraction.over === 'clamp';
      return {
        severity: clamp ? 'warning' : 'error',
        field: 'length',
        message: `${ctx.column.name}: ${ctx.base}의 괄호 숫자는 초 아래 자릿수라 0~6만 됩니다 (지금 ${ctx.args})${clamp ? `. ${ctx.dialect.label}은 6으로 줄여 만듭니다` : ''}`,
        fix: { label: '길이 지우기', patch: { length: '' } },
      };
    },
  },

  // ── 길이 ────────────────────────────────────────────────
  {
    code: 'length-not-allowed',
    autoFix: true,
    check(ctx) {
      if (!ctx.args || !ctx.dialect.types.noLength?.has(ctx.base)) return undefined;
      return { severity: 'error', field: 'length', message: `${ctx.column.name}: ${ctx.base}에는 길이를 쓸 수 없습니다 (지금 ${ctx.args})`, fix: { label: '길이 지우기', patch: { length: '' } } };
    },
  },
  {
    code: 'length-ignored',
    autoFix: true,
    check(ctx) {
      if (!ctx.dialect.types.reportsIgnoredLength) return undefined;
      const length = ctx.column.length.replace(/\s+/g, '').toUpperCase();
      if (!length || ENUM_LIKE.has(ctx.base) || ctx.column.generated?.expression.trim()) return undefined;
      if (ctx.args.replace(/\s+/g, '').toUpperCase() === (length === '-1' ? 'MAX' : length)) return undefined;
      return {
        severity: 'info',
        field: 'length',
        message: `${ctx.column.name}: ${ctx.dialect.label}에서는 ${ctx.column.type}의 길이 ${ctx.column.length}을(를) 쓰지 않고 ${ctx.rendered}(으)로 만듭니다`,
        fix: { label: '길이 지우기', patch: { length: '' } },
      };
    },
  },
  {
    code: 'varchar-length-required',
    autoFix: true,
    check(ctx) {
      if (!ctx.dialect.types.lengthRequired?.has(ctx.base) || ctx.args) return undefined;
      return { severity: 'error', field: 'length', message: `${ctx.column.name}: ${ctx.base}는 길이가 꼭 있어야 합니다`, fix: { label: '길이 255', patch: { length: '255' } } };
    },
  },
  {
    code: 'string-length',
    check(ctx) {
      const t = ctx.dialect.types;
      const limit = t.strings[ctx.base];
      if (!limit || !ctx.args) return undefined;
      const args = ctx.args.trim().toUpperCase();
      if (args === 'MAX' && limit.useMax) return undefined;
      // 길이 뒤 단위 (Oracle: VARCHAR2(100 CHAR))
      const n = t.lengthSuffix ? args.replace(t.lengthSuffix, '') : args;
      if (!isInt(n) || Number(n) < 1) {
        return { severity: 'error', field: 'length', message: `${ctx.column.name}: ${ctx.base}의 길이는 1 이상의 숫자여야 합니다 (지금 ${ctx.args})` };
      }
      const len = Number(n);
      if (len > limit.max) {
        const fix = limit.useMax ? { label: 'MAX로', patch: { length: 'MAX' } } : t.tooLongToText && ctx.base === 'VARCHAR' ? { label: 'TEXT로', patch: { type: 'TEXT', length: '' } } : { label: `${limit.max}로`, patch: { length: String(limit.max) } };
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
    check(ctx) {
      const t = ctx.dialect.types;
      if (!t.integerDisplayWidth || !t.autoIncrement.integers.has(ctx.base) || !ctx.args) return undefined;
      if (isInt(ctx.args) && Number(ctx.args) <= 255) return undefined;
      return { severity: 'error', field: 'length', message: `${ctx.column.name}: ${ctx.base}의 괄호 숫자(표시 폭)는 0~255만 됩니다 (지금 ${ctx.args}). 정수 타입은 길이를 비워 두면 됩니다`, fix: { label: '길이 지우기', patch: { length: '' } } };
    },
  },
  {
    code: 'decimal-precision',
    check(ctx) {
      const limit = ctx.dialect.types.decimal;
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

  // ── 수정 시 값 (ON UPDATE CURRENT_TIMESTAMP 모듈) ─────────
  {
    code: 'on-update-type',
    autoFix: true,
    check(ctx) {
      const feature = ctx.dialect.features.onUpdateTimestamp;
      if (!feature || !ctx.column.onUpdate?.trim() || feature.types.test(ctx.base)) return undefined;
      return { severity: 'error', field: 'onUpdate', message: `${ctx.column.name}: ON UPDATE ${ctx.column.onUpdate}는 DATETIME·TIMESTAMP에만 쓸 수 있습니다`, fix: { label: 'ON UPDATE 끄기', patch: { onUpdate: undefined } } };
    },
  },
  {
    code: 'on-update-precision',
    autoFix: true,
    check(ctx) {
      if (!ctx.dialect.types.onUpdatePrecisionStrict || (ctx.base !== 'DATETIME' && ctx.base !== 'TIMESTAMP')) return undefined;
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
    check({ dialect, column }) {
      if (!dialect.features.onUpdateTimestamp || !column.onUpdate?.trim()) return undefined;
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
    // ON UPDATE 모듈이 없는 DB: 만들지 않는다
    code: 'on-update-ignored',
    check(ctx) {
      if (ctx.dialect.features.onUpdateTimestamp || !ctx.column.onUpdate?.trim()) return undefined;
      return { severity: 'info', field: 'onUpdate', message: `${ctx.column.name}: ${ctx.dialect.label}에는 ON UPDATE ${ctx.column.onUpdate}가 없어 만들지 않습니다 (트리거가 필요)`, fix: { label: 'ON UPDATE 끄기', patch: { onUpdate: undefined } } };
    },
  },

  // ── 기본값 ──────────────────────────────────────────────
  {
    code: 'default-time-type',
    check(ctx) {
      const strict = ctx.dialect.types.defaultTimeStrict;
      const p = timePrecision(ctx.column.defaultValue);
      if (!strict || p === null || ctx.column.autoIncrement) return undefined;
      if (!strict.types.has(ctx.base)) {
        return { severity: 'error', field: 'defaultValue', message: `${ctx.column.name}: 기본값 ${ctx.column.defaultValue}는 ${[...strict.types].join('·')}에만 쓸 수 있습니다 (지금 ${ctx.rendered})` };
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
    check(ctx) {
      const lob = ctx.dialect.types.lobNoLiteralDefault;
      const v = ctx.column.defaultValue?.trim();
      if (!lob || !v || /^null$/i.test(v) || v.startsWith('(') || !lob.test(ctx.base)) return undefined;
      return {
        severity: 'error',
        field: 'defaultValue',
        message: `${ctx.column.name}: ${ctx.dialect.label}의 ${ctx.base}에는 값 그대로의 기본값을 둘 수 없습니다. 괄호로 감싼 식만 됩니다`,
        fix: { label: `(${v})로`, patch: { defaultValue: `(${v})` } },
      };
    },
  },
  {
    code: 'default-not-number',
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
    check(ctx) {
      if (!ctx.dialect.types.booleanLiteral) return undefined;
      const v = ctx.column.defaultValue?.trim().replace(/^'|'$/g, '');
      if (ctx.base !== 'BOOLEAN' || (v !== '0' && v !== '1')) return undefined;
      const value = v === '1' ? 'TRUE' : 'FALSE';
      return { severity: 'error', field: 'defaultValue', message: `${ctx.column.name}: ${ctx.dialect.label} BOOLEAN의 기본값은 TRUE/FALSE로 씁니다 (지금 ${ctx.column.defaultValue})`, fix: { label: `${value}로`, patch: { defaultValue: value } } };
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
  return { dialect, column, rendered, ...parseRendered(rendered) };
}

function runRules(dialect: Dialect, column: Column, only?: (rule: Rule) => boolean): (TypeIssue & { autoFix?: boolean })[] {
  // SQL Server 계산 컬럼은 타입을 DB가 정한다
  if (column.generated?.expression.trim() && dialect.features.generated?.typed === false) return [];
  const ctx = contextOf(dialect, column);
  // ENUM·SET은 괄호 안이 값 목록이라 길이 규칙은 보지 않는다. ENUM이 없는 DB인지만 본다
  if (ENUM_LIKE.has(ctx.base)) {
    const found = RULES.find((r) => r.code === 'enum-unsupported')!;
    const issue = !only || only(found) ? found.check(ctx) : undefined;
    return issue ? [{ code: found.code, ...issue }] : [];
  }
  const issues: (TypeIssue & { autoFix?: boolean })[] = [];
  for (const rule of RULES) {
    if (only && !only(rule)) continue;
    const found = rule.check(ctx);
    if (found) issues.push({ code: rule.code, ...found, autoFix: rule.autoFix });
  }
  return issues;
}

/**
 * 컬럼 하나의 타입 문제. enums를 주면 ENUM을 쓰는 컬럼은 이 DB에서 실제로 만들 타입으로 보고 검사한다
 * (PostgreSQL은 CREATE TYPE으로 만든 타입이라 검사하지 않음)
 */
export function columnTypeIssues(dialect: Dialect | DialectId | string, column: Column, enums?: EnumType[]): TypeIssue[] {
  const d = asDialect(dialect);
  if (enumOfType(enums, column.type) && d.features.enum) {
    // 타입 객체로 만드는 ENUM은 이 DB가 만든 타입이라 검사하지 않는다
    if (d.features.enum.kind === 'type') return [];
    column = resolveEnumColumn(column, enums, d);
  }
  return runRules(d, column).map(({ autoFix: _autoFix, ...issue }) => issue);
}

/** 테이블의 타입 문제 (컬럼별 + 테이블 단위: 자동 증가 컬럼 개수, MySQL 자동 증가 컬럼의 인덱스) */
export function tableTypeIssues(dialect: Dialect | DialectId | string, table: Table, enums?: EnumType[]): TableTypeIssue[] {
  const d = asDialect(dialect);
  const issues: TableTypeIssue[] = table.columns.flatMap((c) => columnTypeIssues(d, c, enums).map((i) => ({ ...i, columnId: c.id, columnName: c.name })));
  const auto = table.columns.filter((c) => c.autoIncrement && !c.generated?.expression.trim());
  const t = d.types;
  if (auto.length > 1 && t.autoIncrement.single) {
    for (const c of auto.slice(1)) {
      issues.push({
        code: 'auto-increment-multiple', severity: 'error', field: 'autoIncrement', columnId: c.id, columnName: c.name,
        message: `${table.name}: ${d.label}는 자동 증가 컬럼을 테이블에 하나만 둘 수 있습니다 (${auto.map((x) => x.name).join(', ')})`,
        fix: { label: '자동 증가 끄기', patch: { autoIncrement: false } },
      });
    }
  }
  if (t.rowSize) {
    const row = t.rowSize.bytes(table.columns);
    if (row.bytes > t.rowSize.max && row.widest) {
      issues.push({
        code: 'row-size', severity: 'error', field: 'length', columnId: row.widest.id, columnName: row.widest.name,
        message: `${table.name}: 한 행의 최대 크기 ${t.rowSize.max}바이트를 넘습니다 (약 ${row.bytes}바이트, utf8mb4는 한 글자 4바이트). 긴 VARCHAR를 TEXT로 바꾸세요 (가장 긴 것: ${row.widest.name})`,
        fix: { label: `${row.widest.name}을(를) TEXT로`, patch: { type: 'TEXT', length: '' } },
      });
    }
  }
  if (t.autoIncrement.mustBeKey) {
    const pkFirst = table.columns.find((c) => c.primaryKey)?.id;
    for (const c of auto) {
      const keyed = pkFirst === c.id || c.unique || table.indexes.some((i) => !i.expression?.trim() && i.columnIds[0] === c.id);
      if (keyed) continue;
      issues.push({
        code: 'auto-increment-key', severity: 'error', field: 'autoIncrement', columnId: c.id, columnName: c.name,
        message: `${c.name}: ${t.autoIncrement.label} 컬럼은 기본키(첫 번째 컬럼)이거나 인덱스의 첫 번째 컬럼이어야 합니다`,
        fix: { label: 'UNIQUE로', patch: { unique: true } },
      });
    }
  }
  return issues;
}



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
