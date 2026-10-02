// 설계 검사: 자주 하는 설계 실수를 찾아 목록으로 돌려준다. 스키마는 바꾸지 않는다.

import type { DialectId } from './dialects/types';
import type { Column, Schema, Table } from './model';

export type LintRule =
  | 'no-primary-key'
  | 'fk-type-mismatch'
  | 'fk-without-index'
  | 'naming-mixed'
  | 'missing-logical-name'
  | 'duplicate-index'
  | 'varchar-no-length';

export type LintSeverity = 'error' | 'warning' | 'info';

export interface LintIssue {
  /** 같은 문제는 같은 id (무시 목록·화면 key에 쓴다) */
  id: string;
  rule: LintRule;
  severity: LintSeverity;
  tableId: string;
  tableName: string;
  columnId?: string;
  columnName?: string;
  message: string;
  /** 바로 고칠 수 있으면 방법 */
  fix?: { kind: 'addIndex'; tableId: string; columnIds: string[] };
}

export const LINT_RULES: Record<LintRule, { label: string; severity: LintSeverity; description: string }> = {
  'no-primary-key': { label: '기본키 없음', severity: 'error', description: '기본키가 없으면 행을 하나로 가리킬 수 없고, 많은 도구(ORM·복제)가 제대로 동작하지 않습니다.' },
  'fk-type-mismatch': { label: 'FK 타입 불일치', severity: 'error', description: '외래키 컬럼과 참조하는 기본키의 타입·길이가 다르면 FK를 만들 수 없거나 비교할 때 느려집니다.' },
  'fk-without-index': { label: 'FK에 인덱스 없음', severity: 'warning', description: '외래키 컬럼에 인덱스가 없으면 조인·부모 삭제가 느려집니다 (MySQL/MariaDB는 자동으로 만들어 검사하지 않습니다).' },
  'naming-mixed': { label: '이름 규칙 섞임', severity: 'warning', description: 'snake_case와 camelCase가 섞여 있습니다. 많이 쓰는 쪽에 맞추세요.' },
  'missing-logical-name': { label: '논리명 없음', severity: 'info', description: '논리명(한글 이름)이나 설명이 없으면 정의서·다른 사람이 보기 어렵습니다.' },
  'duplicate-index': { label: '중복 인덱스', severity: 'warning', description: '같은 컬럼 조합의 인덱스가 두 개 이상이면 저장 공간과 쓰기 속도만 낭비됩니다.' },
  'varchar-no-length': { label: '문자 길이 없음', severity: 'warning', description: 'VARCHAR/CHAR에 길이가 없으면 DB에 따라 오류가 나거나 의도와 다른 길이가 됩니다.' },
};

type Style = 'snake' | 'camel' | null;
function styleOf(name: string): Style {
  if (/^[a-z][a-z0-9]*([A-Z][a-z0-9]*)+$/.test(name)) return 'camel';
  if (/^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(name)) return 'snake';
  return null; // 한 단어(id, status 등)는 어느 쪽도 아님
}

const typeKey = (c: Column) => `${c.type.toUpperCase().replace(/\s+UNSIGNED$/, '')}(${c.length.replace(/\s+/g, '')})${/UNSIGNED/i.test(c.type) ? ' UNSIGNED' : ''}`;
const SAME_TYPES: Record<string, string> = { INTEGER: 'INT', INT4: 'INT', INT8: 'BIGINT', SERIAL: 'INT', BIGSERIAL: 'BIGINT', BOOL: 'BOOLEAN' };
const normType = (c: Column) => {
  const base = c.type.toUpperCase().split(/\s+/)[0];
  return typeKey({ ...c, type: c.type.toUpperCase().replace(base, SAME_TYPES[base] ?? base) });
};

export function lintSchema(schema: Schema, dialect: DialectId | string): LintIssue[] {
  const issues: LintIssue[] = [];
  const add = (rule: LintRule, table: Table, message: string, extra: Partial<LintIssue> = {}) =>
    issues.push({
      id: `${rule}:${table.id}${extra.columnId ? `:${extra.columnId}` : ''}${extra.fix ? `:${extra.fix.columnIds.join('+')}` : ''}`,
      rule,
      severity: LINT_RULES[rule].severity,
      tableId: table.id,
      tableName: table.name,
      message,
      ...extra,
    });

  // 기본키
  for (const t of schema.tables) if (!t.columns.some((c) => c.primaryKey)) add('no-primary-key', t, `${t.name}: 기본키가 없습니다`);

  // 외래키: 타입, 인덱스
  const autoFkIndex = dialect === 'mysql' || dialect === 'mariadb';
  for (const r of schema.relations) {
    const child = schema.tables.find((t) => t.id === r.fromTableId);
    const parent = schema.tables.find((t) => t.id === r.toTableId);
    if (!child || !parent) continue;
    r.fromColumnIds.forEach((cid, i) => {
      const c = child.columns.find((x) => x.id === cid);
      const p = parent.columns.find((x) => x.id === r.toColumnIds[i]);
      if (c && p && normType(c) !== normType(p)) {
        add('fk-type-mismatch', child, `${child.name}.${c.name} (${typeKey(c)})가 ${parent.name}.${p.name} (${typeKey(p)})와 타입이 다릅니다`, { columnId: c.id, columnName: c.name });
      }
    });
    if (!autoFkIndex) {
      // FK 컬럼이 어떤 인덱스(또는 기본키)의 앞부분이면 충분하다
      const fk = r.fromColumnIds;
      const pk = child.columns.filter((c) => c.primaryKey).map((c) => c.id);
      const covered = [pk, ...child.indexes.map((i) => i.columnIds)].some((cols) => fk.every((id, i) => cols[i] === id));
      if (!covered && fk.length) {
        const names = fk.map((id) => child.columns.find((c) => c.id === id)?.name ?? '?').join(', ');
        add('fk-without-index', child, `${child.name}(${names}) → ${parent.name}: 외래키에 인덱스가 없습니다`, {
          columnId: fk[0],
          columnName: names,
          fix: { kind: 'addIndex', tableId: child.id, columnIds: [...fk] },
        });
      }
    }
  }

  // 이름 규칙: 테이블 이름끼리, 컬럼 이름끼리 많이 쓰는 쪽에 맞지 않는 것
  const tableStyles = schema.tables.map((t) => [t, styleOf(t.name)] as const);
  const majority = (styles: Style[]): Style => {
    const snake = styles.filter((s) => s === 'snake').length;
    const camel = styles.filter((s) => s === 'camel').length;
    if (!snake || !camel || snake === camel) return null;
    return snake > camel ? 'snake' : 'camel';
  };
  const label = (s: Style) => (s === 'snake' ? 'snake_case' : 'camelCase');
  const tMajor = majority(tableStyles.map(([, s]) => s));
  if (tMajor) for (const [t, s] of tableStyles) if (s && s !== tMajor) add('naming-mixed', t, `${t.name}: 테이블 이름이 ${label(s)}입니다 (대부분 ${label(tMajor)})`);
  const cols = schema.tables.flatMap((t) => t.columns.map((c) => [t, c, styleOf(c.name)] as const));
  const cMajor = majority(cols.map(([, , s]) => s));
  if (cMajor) for (const [t, c, s] of cols) if (s && s !== cMajor) add('naming-mixed', t, `${t.name}.${c.name}: 컬럼 이름이 ${label(s)}입니다 (대부분 ${label(cMajor)})`, { columnId: c.id, columnName: c.name });

  // 논리명
  for (const t of schema.tables) {
    if (!t.logicalName.trim() && !t.comment.trim()) add('missing-logical-name', t, `${t.name}: 테이블 논리명이 없습니다`);
    for (const c of t.columns) {
      if (!c.logicalName.trim() && !c.comment.trim()) add('missing-logical-name', t, `${t.name}.${c.name}: 컬럼 논리명이 없습니다`, { columnId: c.id, columnName: c.name });
    }
  }

  // 중복 인덱스 (기본키와 같은 것 포함)
  for (const t of schema.tables) {
    const seen = new Map<string, string>();
    const pk = t.columns.filter((c) => c.primaryKey).map((c) => c.id).join(',');
    if (pk) seen.set(pk, '기본키');
    for (const i of t.indexes) {
      const key = i.columnIds.join(',');
      const prev = seen.get(key);
      if (prev) add('duplicate-index', t, `${t.name}: 인덱스 ${i.name || `(${i.columnIds.length}개 컬럼)`}가 ${prev}와 같은 컬럼입니다`);
      else seen.set(key, i.name || '다른 인덱스');
    }
  }

  // 문자 길이
  for (const t of schema.tables) {
    for (const c of t.columns) {
      if (/^(VARCHAR|CHAR|NVARCHAR|NCHAR|VARCHAR2|NVARCHAR2|CHARACTER VARYING)$/i.test(c.type.trim()) && !c.length.trim()) {
        add('varchar-no-length', t, `${t.name}.${c.name}: ${c.type}에 길이가 없습니다`, { columnId: c.id, columnName: c.name });
      }
    }
  }

  const order: Record<LintSeverity, number> = { error: 0, warning: 1, info: 2 };
  return issues.sort((a, b) => order[a.severity] - order[b.severity] || a.tableName.localeCompare(b.tableName));
}
