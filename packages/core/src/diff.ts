import type { ColumnField, Dialect } from './dialects/types';
import { columnWarnings, indexWarnings, sqlComment } from './dialects/common';
import {
  cloneSchema,
  expressionColumns,
  findTable,
  indexLabel,
  isExpressionIndex,
  primaryKeyColumns,
  sameExpression,
  sameIndexMethod,
  type CheckConstraint,
  type Column,
  type Index,
  type Relation,
  type Schema,
  type Table,
} from './model';

/**
 * create: 새 테이블과 그 테이블의 인덱스·FK
 * alter: 이미 있는 테이블의 수정
 * drop: 테이블 삭제 (와 그 테이블의 FK 삭제)
 */
export type ChangeCategory = 'create' | 'alter' | 'drop';

interface ChangeBase {
  /** 선택/적용에 쓰는 고유 키. 같은 변경이면 항상 같은 값이다. */
  id: string;
  category: ChangeCategory;
  tableName: string;
  /** 사람이 읽는 설명 */
  summary: string;
  /** 데이터 손실·실패 가능성 경고 */
  warning?: string;
}

export type Change = ChangeBase &
  (
    | { kind: 'createTable'; table: Table }
    | { kind: 'dropTable'; table: Table }
    | { kind: 'renameTable'; before: Table; after: Table }
    | { kind: 'tableComment'; table: Table }
    | { kind: 'addColumn'; table: Table; column: Column; previous: Column | null }
    | { kind: 'dropColumn'; table: Table; column: Column }
    | { kind: 'alterColumn'; table: Table; before: Column; after: Column; fields: ColumnField[]; beforeTable?: Table }
    | { kind: 'primaryKey'; before: Table; after: Table }
    | { kind: 'addIndex'; table: Table; index: Index }
    | { kind: 'dropIndex'; table: Table; index: Index }
    | { kind: 'addForeignKey'; relation: Relation }
    | { kind: 'dropForeignKey'; relation: Relation }
    | { kind: 'addCheck'; table: Table; check: CheckConstraint }
    | { kind: 'dropCheck'; table: Table; check: CheckConstraint }
  );

export type ChangeKind = Change['kind'];

export interface DiffResult {
  /** 정규화된 기준 스키마 (지금 DB 또는 이전 버전) */
  base: Schema;
  /** 정규화된 목표 스키마 (지금 ERD) */
  target: Schema;
  changes: Change[];
}

/**
 * 비교 전에 표현 방식을 맞춘다.
 * - 컬럼의 UNIQUE 표시는 단일 컬럼 UNIQUE 인덱스로 바꾼다 (DB에서 읽으면 인덱스로 나오므로).
 * - 컬럼이 없는 인덱스, 컬럼이 비어 있는 관계는 아직 미완성이므로 뺀다.
 */
export function normalizeSchema(input: Schema): Schema {
  const schema = cloneSchema(input);
  for (const table of schema.tables) {
    const columnIds = new Set(table.columns.map((c) => c.id));
    // 화면에서 아직 조건을 쓰는 중인 CHECK, 식이 빈 계산 컬럼은 미완성이므로 뺀다
    if (table.checks) table.checks = table.checks.filter((k) => k.expression.trim());
    for (const c of table.columns) if (c.generated && !c.generated.expression.trim()) delete c.generated;
    table.indexes = table.indexes
      .map((i) => ({ ...i, columnIds: i.columnIds.filter((id) => columnIds.has(id)) }))
      .filter((i) => i.columnIds.length > 0 || isExpressionIndex(i))
      // 식이 컬럼 이름뿐이면 컬럼 인덱스로 본다 (DB는 그렇게 돌려준다)
      .map((i) => {
        const ids = isExpressionIndex(i) ? expressionColumns(table, i.expression) : null;
        return ids ? { ...i, columnIds: ids, expression: undefined } : i;
      });
    for (const column of table.columns) {
      if (!column.unique || column.primaryKey) continue;
      const exists = table.indexes.some((i) => i.unique && i.columnIds.length === 1 && i.columnIds[0] === column.id);
      if (!exists) table.indexes.push({ id: `uq_${column.id}`, name: '', columnIds: [column.id], unique: true });
    }
  }
  schema.relations = schema.relations.filter((r) => {
    const from = findTable(schema, r.fromTableId);
    const to = findTable(schema, r.toTableId);
    if (!from || !to) return false;
    if (r.fromColumnIds.length === 0 || r.fromColumnIds.length !== r.toColumnIds.length) return false;
    return (
      r.fromColumnIds.every((id) => from.columns.some((c) => c.id === id)) &&
      r.toColumnIds.every((id) => to.columns.some((c) => c.id === id))
    );
  });
  return schema;
}

/** 한쪽 이름이 비어 있으면(자동 이름) 같은 것으로 본다. */
function sameName(a: string, b: string): boolean {
  return !a || !b || a === b;
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function byId<T extends { id: string }>(items: T[]): Map<string, T> {
  return new Map(items.map((i) => [i.id, i]));
}

const effectiveNullable = (c: Column) => c.nullable && !c.primaryKey;

const FIELD_LABEL: Record<ColumnField, string> = {
  name: '이름',
  type: '타입',
  nullable: 'NULL 허용',
  defaultValue: '기본값',
  generated: '계산식',
  onUpdate: '수정 시 값(ON UPDATE)',
  autoIncrement: '자동 증가',
  comment: '코멘트',
};

function lengthNumber(length: string): number | null {
  const n = Number.parseInt(length.split(',')[0] ?? '', 10);
  return Number.isFinite(n) ? n : null;
}

function columnWarning(before: Column, after: Column, fields: ColumnField[]): string | undefined {
  const warnings: string[] = [];
  if (fields.includes('type')) {
    const sameBaseType = before.type.toUpperCase() === after.type.toUpperCase();
    const oldLen = lengthNumber(before.length);
    const newLen = lengthNumber(after.length);
    if (!sameBaseType) warnings.push('타입이 바뀌어 변환에 실패하거나 값이 바뀔 수 있습니다');
    else if (oldLen !== null && newLen !== null && newLen < oldLen) warnings.push('길이가 줄어 기존 데이터가 잘리거나 실패할 수 있습니다');
  }
  if (fields.includes('nullable') && !effectiveNullable(after) && effectiveNullable(before)) {
    warnings.push('NULL 값이 있는 행이 있으면 실패합니다');
  }
  return warnings.length ? warnings.join(' / ') : undefined;
}

export function diffSchemas(baseInput: Schema, targetInput: Schema, dialect: Dialect): DiffResult {
  const base = normalizeSchema(baseInput);
  const target = normalizeSchema(targetInput);
  const changes: Change[] = [];

  const baseTables = byId(base.tables);
  const targetTables = byId(target.tables);
  const createdTableIds = new Set<string>();
  const droppedTableIds = new Set<string>();

  for (const table of target.tables) {
    const before = baseTables.get(table.id);
    if (!before) {
      createdTableIds.add(table.id);
      const tableWarning = table.columns.map((c) => columnWarnings(dialect, c)).filter(Boolean).join(' / ') || undefined;
      changes.push({ kind: 'createTable', id: `createTable:${table.id}`, category: 'create', tableName: table.name, summary: `${table.name} 테이블 생성`, table, warning: tableWarning });
      for (const check of table.checks ?? []) {
        changes.push({ kind: 'addCheck', id: `addCheck:${table.id}:${check.id}`, category: 'create', tableName: table.name, summary: `${table.name} CHECK 추가 (${check.expression})`, table, check });
      }
      for (const index of table.indexes) {
        changes.push({
          kind: 'addIndex', id: `addIndex:${table.id}:${index.id}`, category: 'create', tableName: table.name,
          summary: `${table.name} 인덱스 생성 (${index.unique ? 'UNIQUE ' : ''}${indexLabel(table, index)})`, table, index,
          warning: indexWarnings(dialect, table, index),
        });
      }
      continue;
    }
    diffTable(dialect, before, table, changes);
  }

  for (const table of base.tables) {
    if (targetTables.has(table.id)) continue;
    droppedTableIds.add(table.id);
    changes.push({
      kind: 'dropTable', id: `dropTable:${table.id}`, category: 'drop', tableName: table.name,
      summary: `${table.name} 테이블 삭제`, warning: '테이블과 모든 데이터가 삭제됩니다', table,
    });
  }

  const baseRelations = byId(base.relations);
  const targetRelations = byId(target.relations);
  const tableNameOf = (schema: Schema, id: string) => findTable(schema, id)?.name ?? id;

  const dropFk = (relation: Relation) => {
    const tableName = tableNameOf(base, relation.fromTableId);
    changes.push({
      kind: 'dropForeignKey', id: `dropForeignKey:${relation.id}`,
      category: droppedTableIds.has(relation.fromTableId) ? 'drop' : 'alter',
      tableName, summary: `${tableName} → ${tableNameOf(base, relation.toTableId)} 외래키 삭제`, relation,
    });
  };
  const addFk = (relation: Relation) => {
    const tableName = tableNameOf(target, relation.fromTableId);
    changes.push({
      kind: 'addForeignKey', id: `addForeignKey:${relation.id}`,
      category: createdTableIds.has(relation.fromTableId) ? 'create' : 'alter',
      tableName, summary: `${tableName} → ${tableNameOf(target, relation.toTableId)} 외래키 추가`, relation,
    });
  };

  const sameRelation = (a: Relation, b: Relation) =>
    a.fromTableId === b.fromTableId &&
    a.toTableId === b.toTableId &&
    sameList(a.fromColumnIds, b.fromColumnIds) &&
    sameList(a.toColumnIds, b.toColumnIds) &&
    dialect.normalizeAction(a.onDelete) === dialect.normalizeAction(b.onDelete) &&
    (dialect.supportsOnUpdate === false || dialect.normalizeAction(a.onUpdate) === dialect.normalizeAction(b.onUpdate)) &&
    sameName(a.name, b.name);

  for (const relation of base.relations) {
    const after = targetRelations.get(relation.id);
    if (!after || !sameRelation(relation, after)) dropFk(relation);
  }
  for (const relation of target.relations) {
    const before = baseRelations.get(relation.id);
    if (!before || !sameRelation(before, relation)) addFk(relation);
  }

  return { base, target, changes };
}

function columnList(table: Table, ids: string[]): string {
  return ids.map((id) => table.columns.find((c) => c.id === id)?.name ?? id).join(', ');
}

function diffTable(dialect: Dialect, before: Table, after: Table, changes: Change[]): void {
  const name = after.name;

  if (before.name !== after.name) {
    changes.push({ kind: 'renameTable', id: `renameTable:${after.id}`, category: 'alter', tableName: name, summary: `테이블 이름 변경 ${before.name} → ${after.name}`, before, after });
  }
  if (sqlComment(before) !== sqlComment(after)) {
    changes.push({ kind: 'tableComment', id: `tableComment:${after.id}`, category: 'alter', tableName: name, summary: `${name} 테이블 코멘트 변경`, table: after });
  }

  // 인덱스 삭제는 컬럼 변경보다 먼저 실행되므로 이전 테이블 기준으로 만든다.
  const beforeIndexes = byId(before.indexes);
  const afterIndexes = byId(after.indexes);
  for (const index of before.indexes) {
    const next = afterIndexes.get(index.id);
    if (!next || !sameIndex(index, next)) {
      changes.push({ kind: 'dropIndex', id: `dropIndex:${after.id}:${index.id}`, category: 'alter', tableName: name, summary: `${name} 인덱스 삭제 (${indexLabel(before, index)})`, table: before, index });
    }
  }

  // CHECK 제약: 이름이나 식이 바뀌면 지우고 다시 만든다
  const afterChecks = byId(after.checks ?? []);
  const beforeChecks = byId(before.checks ?? []);
  for (const check of before.checks ?? []) {
    const next = afterChecks.get(check.id);
    if (!next || !sameCheck(before, check, after, next)) {
      changes.push({ kind: 'dropCheck', id: `dropCheck:${after.id}:${check.id}`, category: 'alter', tableName: name, summary: `${name} CHECK 삭제 (${check.expression})`, table: before, check });
    }
  }
  for (const check of after.checks ?? []) {
    const old = beforeChecks.get(check.id);
    if (!old || !sameCheck(before, old, after, check)) {
      changes.push({ kind: 'addCheck', id: `addCheck:${after.id}:${check.id}`, category: 'alter', tableName: name, summary: `${name} CHECK 추가 (${check.expression})`, warning: '조건에 맞지 않는 기존 데이터가 있으면 실패합니다', table: after, check });
    }
  }

  const beforeColumns = byId(before.columns);
  const afterColumns = byId(after.columns);
  after.columns.forEach((column, i) => {
    const old = beforeColumns.get(column.id);
    if (!old) {
      const needsDefault = !effectiveNullable(column) && !column.defaultValue && !column.autoIncrement;
      changes.push({
        kind: 'addColumn', id: `addColumn:${after.id}:${column.id}`, category: 'alter', tableName: name,
        summary: `${name}.${column.name} 컬럼 추가`,
        warning: needsDefault ? '기존 행이 있으면 NOT NULL 컬럼 추가에 기본값이 필요합니다' : undefined,
        table: after, column, previous: i > 0 ? after.columns[i - 1] : null,
      });
      return;
    }
    const fields: ColumnField[] = [];
    if (old.name !== column.name) fields.push('name');
    if (dialect.renderType(old) !== dialect.renderType(column)) fields.push('type');
    if (effectiveNullable(old) !== effectiveNullable(column)) fields.push('nullable');
    if (dialect.normalizeDefault(old.defaultValue) !== dialect.normalizeDefault(column.defaultValue)) fields.push('defaultValue');
    // ON UPDATE CURRENT_TIMESTAMP는 MySQL·MariaDB에만 있다
    if ((dialect.id === 'mysql' || dialect.id === 'mariadb') && (old.onUpdate?.trim().toUpperCase() ?? '') !== (column.onUpdate?.trim().toUpperCase() ?? '')) fields.push('onUpdate');
    if (!sameGenerated(dialect, old, column)) fields.push('generated');
    if (old.autoIncrement !== column.autoIncrement) fields.push('autoIncrement');
    if (sqlComment(old) !== sqlComment(column)) fields.push('comment');
    if (!fields.length) return;
    const detail = fields
      .map((f) => {
        if (f === 'name') return `이름 ${old.name} → ${column.name}`;
        if (f === 'type') return `타입 ${dialect.renderType(old)} → ${dialect.renderType(column)}`;
        if (f === 'generated') return column.generated?.expression.trim() ? `계산식 ${column.generated.expression}${column.generated.stored ? ' (STORED)' : ''}` : '계산 컬럼 해제';
        if (f === 'nullable') return effectiveNullable(column) ? 'NULL 허용' : 'NOT NULL';
        if (f === 'defaultValue') return `기본값 ${old.defaultValue ?? '없음'} → ${column.defaultValue ?? '없음'}`;
        return FIELD_LABEL[f];
      })
      .join(', ');
    changes.push({
      kind: 'alterColumn', id: `alterColumn:${after.id}:${column.id}`, category: 'alter', tableName: name,
      summary: `${name}.${column.name} 변경: ${detail}`,
      warning: columnWarning(old, column, fields),
      table: after, before: old, after: column, fields, beforeTable: before,
    });
  });

  const oldPk = primaryKeyColumns(before).map((c) => c.id);
  const newPk = primaryKeyColumns(after).map((c) => c.id);
  if (!sameList(oldPk, newPk)) {
    changes.push({
      kind: 'primaryKey', id: `primaryKey:${after.id}`, category: 'alter', tableName: name,
      summary: `${name} 기본키 변경 (${columnList(before, oldPk) || '없음'} → ${columnList(after, newPk) || '없음'})`,
      warning: '기존 데이터가 새 기본키 조건(중복 없음)을 만족하지 않으면 실패합니다',
      before, after,
    });
  }

  for (const column of before.columns) {
    if (afterColumns.has(column.id)) continue;
    changes.push({
      kind: 'dropColumn', id: `dropColumn:${after.id}:${column.id}`, category: 'alter', tableName: name,
      summary: `${name}.${column.name} 컬럼 삭제`, warning: '컬럼의 데이터가 모두 삭제됩니다', table: after, column,
    });
  }

  for (const index of after.indexes) {
    const old = beforeIndexes.get(index.id);
    if (!old || !sameIndex(old, index)) {
      changes.push({
        kind: 'addIndex', id: `addIndex:${after.id}:${index.id}`, category: 'alter', tableName: name,
        summary: `${name} 인덱스 생성 (${index.unique ? 'UNIQUE ' : ''}${indexLabel(after, index)})`,
        warning: [index.unique ? '중복 값이 있으면 실패합니다' : '', indexWarnings(dialect, after, index) ?? ''].filter(Boolean).join(' / ') || undefined,
        table: after, index,
      });
    }
  }
}

/** 같은 CHECK인지: 식이 같고, 양쪽 다 이름이 있으면 이름도 같아야 한다 (이름 없는 CHECK는 식으로만 본다) */
function sameCheck(_beforeTable: Table, a: CheckConstraint, _afterTable: Table, b: CheckConstraint): boolean {
  const named = a.name.trim() && b.name.trim();
  return sameExpression(a.expression, b.expression) && (!named || a.name.trim().toLowerCase() === b.name.trim().toLowerCase());
}

/** 계산 컬럼이 같은지 (식은 공백·괄호·따옴표 차이 무시, 저장 방식은 둘 다 되는 DB에서만 비교) */
function sameGenerated(dialect: Dialect, a: Column, b: Column): boolean {
  const ga = a.generated?.expression.trim() ? a.generated : undefined;
  const gb = b.generated?.expression.trim() ? b.generated : undefined;
  if (!ga || !gb) return !ga && !gb;
  const both = dialect.generatedSupport?.virtual && dialect.generatedSupport?.stored;
  return sameExpression(ga.expression, gb.expression) && (!both || Boolean(ga.stored) === Boolean(gb.stored));
}

function sameIndex(a: Index, b: Index): boolean {
  return (
    a.unique === b.unique &&
    sameList(a.columnIds, b.columnIds) &&
    sameName(a.name, b.name) &&
    sameExpression(a.expression, b.expression) &&
    sameIndexMethod(a.method, b.method) &&
    sameExpression(a.where, b.where)
  );
}
