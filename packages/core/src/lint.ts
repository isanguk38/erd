// 설계 검사: 자주 하는 설계 실수를 찾아 목록으로 돌려준다. 스키마는 바꾸지 않는다.

import type { DialectId } from './dialects/types';
import type { Column, Schema, Table } from './model';
import { tableTypeIssues } from './typeRules';
import { checkColumnAgainstDictionary, describeMatch, dictIndex, lookupPhysical, NAME_STYLE_LABEL, styleSuggestion, type DictTerm, type Dictionary } from './dictionary';

export type LintRule =
  | 'no-primary-key'
  | 'fk-type-mismatch'
  | 'fk-without-index'
  | 'naming-mixed'
  | 'missing-logical-name'
  | 'duplicate-index'
  | 'varchar-no-length'
  | 'duplicate-relation'
  | 'type-error'
  | 'type-warning'
  | 'type-ignored'
  | 'dict-mismatch'
  | 'dict-unknown'
  | 'dict-style';

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
  fix?:
    | { kind: 'addIndex'; tableId: string; columnIds: string[] }
    | { kind: 'patchColumn'; tableId: string; columnId: string; label: string; patch: Partial<Column> }
    | { kind: 'removeRelation'; relationId: string }
    | { kind: 'addTerm'; term: DictTerm };
}

export const LINT_RULES: Record<LintRule, { label: string; severity: LintSeverity; description: string }> = {
  'no-primary-key': { label: '기본키 없음', severity: 'error', description: '기본키가 없으면 행을 하나로 가리킬 수 없고, 많은 도구(ORM·복제)가 제대로 동작하지 않습니다.' },
  'fk-type-mismatch': { label: 'FK 타입 불일치', severity: 'error', description: '외래키 컬럼과 참조하는 기본키의 타입·길이가 다르면 FK를 만들 수 없거나 비교할 때 느려집니다.' },
  'fk-without-index': { label: 'FK에 인덱스 없음', severity: 'warning', description: '외래키 컬럼에 인덱스가 없으면 조인·부모 삭제가 느려집니다 (MySQL/MariaDB는 자동으로 만들어 검사하지 않습니다).' },
  'naming-mixed': { label: '이름 규칙 섞임', severity: 'warning', description: 'snake_case와 camelCase가 섞여 있습니다. 많이 쓰는 쪽에 맞추세요.' },
  'missing-logical-name': { label: '논리명 없음', severity: 'info', description: '논리명(한글 이름)이나 설명이 없으면 정의서·다른 사람이 보기 어렵습니다.' },
  'duplicate-index': { label: '중복 인덱스', severity: 'warning', description: '같은 컬럼 조합의 인덱스가 두 개 이상이면 저장 공간과 쓰기 속도만 낭비됩니다.' },
  'varchar-no-length': { label: '문자 길이 없음', severity: 'warning', description: 'VARCHAR/CHAR에 길이가 없으면 DB에 따라 오류가 나거나 의도와 다른 길이가 됩니다.' },
  'duplicate-relation': { label: '중복 관계', severity: 'error', description: '같은 FK 컬럼으로 같은 테이블을 가리키는 관계가 두 번 있습니다. DB로 내보내면 같은 외래키를 두 번 만들다 실패합니다.' },
  'type-error': { label: 'DB에서 실패하는 타입', severity: 'error', description: '이 DB에서 허용하지 않는 타입·길이·자동 증가·기본값 조합입니다. 그대로 DB에 내보내면 실패합니다. (예: VARCHAR에 AUTO_INCREMENT, DATETIME(255))' },
  'type-warning': { label: '타입 주의', severity: 'warning', description: 'DB 설정에 따라 실패하거나 의도와 다르게 동작할 수 있는 타입 설정입니다.' },
  'dict-mismatch': { label: '표준 용어와 다름', severity: 'warning', description: '논리명이 표준 용어 사전에 있는데 물리명이나 타입·길이가 사전과 다릅니다. "표준대로" 버튼으로 맞출 수 있습니다.' },
  'dict-unknown': { label: '사전에 없는 용어', severity: 'warning', description: '논리명이 표준 용어 사전에 없습니다. "사전에 추가"로 이 컬럼의 이름·타입을 새 용어로 넣거나, 사전에 있는 표준 용어로 바꾸세요.' },
  'dict-style': { label: '사전과 다른 표기', severity: 'warning', description: '물리명 표기가 용어 사전(snake_case·camelCase 등)과 다릅니다. 사전과 같은 표기로 바꾸세요.' },
  'type-ignored': { label: 'DB가 무시하는 설정', severity: 'info', description: '이 DB에서는 쓰지 않는 길이·기본값·ON UPDATE입니다. 실패하지는 않지만 ERD와 실제 DB가 달라 보입니다.' },
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

/** FK 타입 비교처럼 같은 타입인지 (INTEGER = INT 등 같은 뜻의 이름은 같게 본다) */
export function sameColumnType(a: Pick<Column, 'type' | 'length'>, b: Pick<Column, 'type' | 'length'>): boolean {
  return normType(a as Column) === normType(b as Column);
}

export interface LintOptions {
  /** 표준 용어 사전 (있으면 컬럼이 사전을 따르는지도 검사) */
  dictionary?: Dictionary | null;
}

export function lintSchema(schema: Schema, dialect: DialectId | string, options: LintOptions = {}): LintIssue[] {
  const issues: LintIssue[] = [];
  const add = (rule: LintRule, table: Table, message: string, extra: Partial<LintIssue> = {}) =>
    issues.push({
      id: `${rule}:${table.id}${extra.columnId ? `:${extra.columnId}` : ''}${extra.fix?.kind === 'addIndex' ? `:${extra.fix.columnIds.join('+')}` : ''}`,
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
      // 식·조건이 있는 인덱스는 컬럼 구성만으로 같다고 볼 수 없다
      if (i.expression?.trim() || i.where?.trim()) continue;
      const key = i.columnIds.join(',');
      const prev = seen.get(key);
      if (prev) add('duplicate-index', t, `${t.name}: 인덱스 ${i.name || `(${i.columnIds.length}개 컬럼)`}가 ${prev}와 같은 컬럼입니다`);
      else seen.set(key, i.name || '다른 인덱스');
    }
  }

  // 문자 길이
  for (const t of schema.tables) {
    for (const c of t.columns) {
      // MySQL·MariaDB의 VARCHAR 길이 없음은 실패하므로 타입 검사(DB에서 실패하는 타입)에서 알린다
      if (dialect === 'mysql' || dialect === 'mariadb') continue;
      if (/^(VARCHAR|CHAR|NVARCHAR|NCHAR|VARCHAR2|NVARCHAR2|CHARACTER VARYING)$/i.test(c.type.trim()) && !c.length.trim()) {
        add('varchar-no-length', t, `${t.name}.${c.name}: ${c.type}에 길이가 없습니다`, { columnId: c.id, columnName: c.name });
      }
    }
  }

  // 중복 관계 (같은 FK 컬럼 → 같은 기본키)
  const seenRelations = new Map<string, string>();
  for (const r of schema.relations) {
    const key = `${r.fromTableId}:${r.fromColumnIds.join(',')}>${r.toTableId}:${r.toColumnIds.join(',')}`;
    const child = schema.tables.find((t) => t.id === r.fromTableId);
    const parent = schema.tables.find((t) => t.id === r.toTableId);
    if (!child || !parent) continue;
    const first = seenRelations.get(key);
    if (!first) {
      seenRelations.set(key, r.id);
      continue;
    }
    const names = r.fromColumnIds.map((id) => child.columns.find((c) => c.id === id)?.name ?? '?').join(', ');
    issues.push({
      id: `duplicate-relation:${r.id}`,
      rule: 'duplicate-relation',
      severity: LINT_RULES['duplicate-relation'].severity,
      tableId: child.id,
      tableName: child.name,
      message: `${child.name}(${names}) → ${parent.name}: 같은 관계가 두 번 있습니다`,
      fix: { kind: 'removeRelation', relationId: r.id },
    });
  }

  // 타입 검사 (DB별 규칙은 typeRules.ts)
  const typeRule = { error: 'type-error', warning: 'type-warning', info: 'type-ignored' } as const;
  for (const t of schema.tables) {
    for (const i of tableTypeIssues(dialect || 'mysql', t)) {
      const rule = typeRule[i.severity];
      issues.push({
        id: `${rule}:${t.id}:${i.columnId}:${i.code}`,
        rule,
        severity: LINT_RULES[rule].severity,
        tableId: t.id,
        tableName: t.name,
        columnId: i.columnId,
        columnName: i.columnName,
        message: i.message.startsWith(`${t.name}:`) ? i.message : `${t.name}.${i.message}`,
        fix: i.fix ? { kind: 'patchColumn', tableId: t.id, columnId: i.columnId, label: i.fix.label, patch: i.fix.patch } : undefined,
      });
    }
  }

  // 표준 용어 사전 (사전이 있을 때만)
  if (options.dictionary?.terms.length) {
    const index = dictIndex(options.dictionary);
    for (const t of schema.tables) {
      for (const c of t.columns) {
        const r = checkColumnAgainstDictionary(index, c);
        if (r?.status === 'ok') continue;
        // 사전에 없는 컬럼: 표기가 사전과 다르면 경고, 같으면 사전에 추가하라고
        if (!r || r.status === 'unknown') {
          const style = styleSuggestion(index, c.name);
          if (style) {
            add('dict-style', t, `${t.name}.${c.name}: 사전은 ${NAME_STYLE_LABEL[style.style]}입니다 — ${style.suggestion}(으)로 바꾸세요`, {
              columnId: c.id,
              columnName: c.name,
              fix: { kind: 'patchColumn', tableId: t.id, columnId: c.id, label: `${style.suggestion}(으)로`, patch: { name: style.suggestion } },
            });
            continue;
          }
          if (!r) continue;
          const owner = lookupPhysical(index, c.name);
          add('dict-unknown', t, owner
            ? `${t.name}.${c.name}: 논리명 "${c.logicalName}"이(가) 사전에 없습니다 (이 물리명은 사전에 "${owner.logical}"(으)로 있음)`
            : `${t.name}.${c.name}: 논리명 "${c.logicalName}"이(가) 표준 용어 사전에 없습니다 — 사전에 추가해 주세요`, {
            columnId: c.id,
            columnName: c.name,
            fix: owner ? { kind: 'patchColumn', tableId: t.id, columnId: c.id, label: `논리명을 "${owner.logical}"(으)로`, patch: { logicalName: owner.logical } } : { kind: 'addTerm', term: { logical: c.logicalName.trim(), physical: c.name, ...(c.type ? { type: c.type } : {}), ...(c.length ? { length: c.length } : {}), ...(c.comment.trim() ? { description: c.comment.trim() } : {}) } },
          });
          continue;
        }
        add('dict-mismatch', t, `${t.name}.${c.name}: "${c.logicalName}"의 표준은 ${describeMatch(r.match!)}입니다 (다른 점: ${r.diffs.join(', ')})`, {
          columnId: c.id,
          columnName: c.name,
          fix: { kind: 'patchColumn', tableId: t.id, columnId: c.id, label: '표준대로', patch: r.patch! },
        });
      }
    }
  }

  const order: Record<LintSeverity, number> = { error: 0, warning: 1, info: 2 };
  return issues.sort((a, b) => order[a.severity] - order[b.severity] || a.tableName.localeCompare(b.tableName));
}
