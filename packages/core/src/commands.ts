// AI(MCP)·외부 도구용 편집 명령. id 대신 이름으로 테이블·컬럼을 가리킨다.
// applyCommands는 전부 성공하거나 전부 실패한다 (원본은 바꾸지 않는다).

import {
  cloneSchema,
  checkName,
  createCheck,
  findTable,
  indexLabel,
  sameExpression,
  primaryKeyColumns,
  type Cardinality,
  type Column,
  type ReferentialAction,
  type Schema,
  type Table,
} from './model';
import {
  addColumn,
  addIndex,
  addTable,
  connectManyToMany,
  connectTables,
  removeColumn,
  removeIndex,
  removeRelation,
  removeTable,
  updateColumn,
  updateTable,
} from './operations';
import { placeNewTables } from './placement';

export interface ColumnSpec {
  name: string;
  logicalName?: string;
  /** "VARCHAR(100)"처럼 길이를 붙여도 된다 */
  type?: string;
  length?: string;
  nullable?: boolean;
  primaryKey?: boolean;
  unique?: boolean;
  autoIncrement?: boolean;
  /** SQL 식 그대로 (문자열은 따옴표 포함: "'Y'") */
  default?: string | null;
  /** MySQL·MariaDB: 행이 바뀔 때 넣는 값 (예: CURRENT_TIMESTAMP). null이면 해제 */
  onUpdate?: string | null;
  /** 계산 컬럼 식 (예: qty * price). null이면 일반 컬럼으로 */
  generated?: string | null;
  /** 계산 값을 저장(STORED)할지. 기본 false(VIRTUAL) */
  generatedStored?: boolean;
  comment?: string;
}

export type Command =
  | { op: 'createTable'; name: string; logicalName?: string; comment?: string; color?: string; columns?: ColumnSpec[] }
  | { op: 'updateTable'; table: string; name?: string; logicalName?: string; comment?: string; color?: string }
  | { op: 'dropTable'; table: string }
  | { op: 'addColumn'; table: string; column: ColumnSpec; after?: string }
  | { op: 'updateColumn'; table: string; column: string; changes: Partial<ColumnSpec> }
  | { op: 'dropColumn'; table: string; column: string }
  | { op: 'addIndex'; table: string; columns?: string[]; unique?: boolean; name?: string; expression?: string; method?: string; where?: string }
  | { op: 'dropIndex'; table: string; name?: string; columns?: string[] }
  | { op: 'addCheck'; table: string; expression: string; name?: string }
  | { op: 'dropCheck'; table: string; name?: string; expression?: string }
  | {
      op: 'addRelation';
      parent: string;
      child: string;
      cardinality?: Cardinality | 'N:M';
      identifying?: boolean;
      onDelete?: ReferentialAction;
      onUpdate?: ReferentialAction;
    }
  | { op: 'dropRelation'; parent: string; child: string; dropColumns?: boolean };

export class CommandError extends Error {
  constructor(public readonly index: number, message: string) {
    super(`${index + 1}번째 명령 실패: ${message}`);
  }
}

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function tableByName(schema: Schema, name: string): Table {
  const table = schema.tables.find((t) => eq(t.name, name)) ?? schema.tables.find((t) => t.logicalName && eq(t.logicalName, name));
  if (!table) throw new Error(`테이블 "${name}"이 없습니다. 있는 테이블: ${schema.tables.map((t) => t.name).join(', ') || '(없음)'}`);
  return table;
}

function columnByName(table: Table, name: string): Column {
  const column = table.columns.find((c) => eq(c.name, name)) ?? table.columns.find((c) => c.logicalName && eq(c.logicalName, name));
  if (!column) throw new Error(`${table.name}에 컬럼 "${name}"이 없습니다. 있는 컬럼: ${table.columns.map((c) => c.name).join(', ')}`);
  return column;
}

/** ColumnSpec → Column 필드 (정의된 값만) */
export function columnPatch(spec: Partial<ColumnSpec>): Partial<Column> {
  const patch: Partial<Column> = {};
  if (spec.name !== undefined) patch.name = spec.name;
  if (spec.logicalName !== undefined) patch.logicalName = spec.logicalName;
  if (spec.type !== undefined) {
    const m = spec.type.trim().match(/^([^(]+?)\s*\(([^)]*)\)\s*(.*)$/);
    if (m) {
      patch.type = `${m[1]} ${m[3]}`.trim().toUpperCase();
      patch.length = m[2].replace(/\s+/g, '');
    } else {
      patch.type = spec.type.trim().toUpperCase();
      if (spec.length === undefined) patch.length = '';
    }
  }
  if (spec.length !== undefined) patch.length = String(spec.length);
  if (spec.nullable !== undefined) patch.nullable = spec.nullable;
  if (spec.primaryKey !== undefined) patch.primaryKey = spec.primaryKey;
  if (spec.unique !== undefined) patch.unique = spec.unique;
  if (spec.autoIncrement !== undefined) patch.autoIncrement = spec.autoIncrement;
  if (spec.default !== undefined) patch.defaultValue = spec.default === '' ? null : spec.default;
  if (spec.onUpdate !== undefined) patch.onUpdate = spec.onUpdate?.trim() ? spec.onUpdate.trim().toUpperCase() : undefined;
  if (spec.generated !== undefined) patch.generated = spec.generated?.trim() ? { expression: spec.generated.trim(), stored: Boolean(spec.generatedStored) } : undefined;

  if (spec.comment !== undefined) patch.comment = spec.comment;
  return patch;
}

function applyOne(schema: Schema, command: Command, created: string[]): string {
  switch (command.op) {
    case 'createTable': {
      if (schema.tables.some((t) => eq(t.name, command.name))) throw new Error(`테이블 "${command.name}"이 이미 있습니다`);
      const table = addTable(schema, { name: command.name, logicalName: command.logicalName ?? '', comment: command.comment ?? '', color: command.color });
      for (const spec of command.columns ?? []) addColumn(schema, table.id, columnPatch(spec));
      created.push(table.id);
      return `${table.name} 테이블 생성 (컬럼 ${table.columns.length}개)`;
    }
    case 'updateTable': {
      const table = tableByName(schema, command.table);
      const { op: _op, table: _t, ...patch } = command;
      updateTable(schema, table.id, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)));
      return `${command.table} 테이블 수정`;
    }
    case 'dropTable': {
      removeTable(schema, tableByName(schema, command.table).id);
      return `${command.table} 테이블 삭제`;
    }
    case 'addColumn': {
      const table = tableByName(schema, command.table);
      if (table.columns.some((c) => eq(c.name, command.column.name))) throw new Error(`${table.name}에 컬럼 "${command.column.name}"이 이미 있습니다`);
      const position = command.after ? table.columns.indexOf(columnByName(table, command.after)) + 1 : undefined;
      addColumn(schema, table.id, columnPatch(command.column), position);
      return `${table.name}.${command.column.name} 컬럼 추가`;
    }
    case 'updateColumn': {
      const table = tableByName(schema, command.table);
      const column = columnByName(table, command.column);
      updateColumn(schema, table.id, column.id, columnPatch(command.changes));
      // 계산식은 그대로 두고 저장 방식만 바꾸는 경우
      if (command.changes.generated === undefined && command.changes.generatedStored !== undefined && column.generated) {
        column.generated = { ...column.generated, stored: command.changes.generatedStored };
      }
      return `${table.name}.${command.column} 컬럼 수정`;
    }
    case 'dropColumn': {
      const table = tableByName(schema, command.table);
      removeColumn(schema, table.id, columnByName(table, command.column).id);
      return `${table.name}.${command.column} 컬럼 삭제`;
    }
    case 'addIndex': {
      const table = tableByName(schema, command.table);
      const expression = command.expression?.trim();
      if (!expression && !command.columns?.length) throw new Error('인덱스 컬럼(columns) 또는 식(expression)이 필요합니다');
      const extra = { ...(command.method?.trim() ? { method: command.method.trim() } : {}), ...(command.where?.trim() ? { where: command.where.trim() } : {}) };
      if (expression) {
        const index = addIndex(schema, table.id, { name: command.name ?? '', unique: Boolean(command.unique), columnIds: [], expression, ...extra });
        return `${table.name} 식 인덱스 추가 (${command.unique ? 'UNIQUE ' : ''}${indexLabel(table, index)})`;
      }
      const index = addIndex(schema, table.id, { name: command.name ?? '', unique: Boolean(command.unique), columnIds: command.columns!.map((n) => columnByName(table, n).id), ...extra });
      return `${table.name} 인덱스 추가 (${command.unique ? 'UNIQUE ' : ''}${indexLabel(table, index)})`;
    }
    case 'dropIndex': {
      const table = tableByName(schema, command.table);
      const ids = command.columns?.map((n) => columnByName(table, n).id);
      const index = table.indexes.find((i) =>
        command.name ? eq(i.name, command.name) : ids ? i.columnIds.length === ids.length && i.columnIds.every((id, k) => id === ids[k]) : false,
      );
      if (index) {
        removeIndex(schema, table.id, index.id);
      } else if (ids?.length === 1) {
        // 컬럼의 UNIQUE 표시로 만든 인덱스
        const column = table.columns.find((c) => c.id === ids[0] && c.unique);
        if (!column) throw new Error(`${table.name}에 해당 인덱스가 없습니다`);
        column.unique = false;
      } else {
        throw new Error(`${table.name}에 해당 인덱스가 없습니다`);
      }
      return `${table.name} 인덱스 삭제`;
    }
    case 'addCheck': {
      const table = tableByName(schema, command.table);
      if (!command.expression?.trim()) throw new Error('CHECK 식(expression)이 필요합니다. 예: point >= 0');
      table.checks = [...(table.checks ?? []), createCheck({ name: command.name?.trim() ?? '', expression: command.expression.trim().replace(/^check\s*/i, '') })];
      return `${table.name} CHECK 추가 (${command.expression.trim()})`;
    }
    case 'dropCheck': {
      const table = tableByName(schema, command.table);
      const check = (table.checks ?? []).find((k) => (command.name ? eq(checkName(table, k), command.name) : sameExpression(k.expression, command.expression)));
      if (!check) throw new Error(`${table.name}에 해당 CHECK 제약이 없습니다`);
      table.checks = (table.checks ?? []).filter((k) => k.id !== check.id);
      if (!table.checks.length) delete table.checks;
      return `${table.name} CHECK 삭제 (${check.expression})`;
    }
    case 'addRelation': {
      const parent = tableByName(schema, command.parent);
      const child = tableByName(schema, command.child);
      if (command.cardinality === 'N:M') {
        const { table } = connectManyToMany(schema, parent.id, child.id);
        created.push(table.id);
        return `${parent.name} ↔ ${child.name} N:M 관계 (연결 테이블 ${table.name})`;
      }
      if (!primaryKeyColumns(parent).length) throw new Error(`${parent.name}에 기본키가 없어 관계를 만들 수 없습니다`);
      connectTables(schema, {
        parentTableId: parent.id,
        childTableId: child.id,
        cardinality: command.cardinality ?? '1:N',
        identifying: command.identifying,
        onDelete: command.onDelete,
        onUpdate: command.onUpdate,
      });
      return `${parent.name} → ${child.name} 관계 추가`;
    }
    case 'dropRelation': {
      const parent = tableByName(schema, command.parent);
      const child = tableByName(schema, command.child);
      const relation = schema.relations.find((r) => r.toTableId === parent.id && r.fromTableId === child.id);
      if (!relation) throw new Error(`${parent.name} → ${child.name} 관계가 없습니다`);
      removeRelation(schema, relation.id, command.dropColumns);
      return `${parent.name} → ${child.name} 관계 삭제`;
    }
  }
}

export interface CommandResult {
  schema: Schema;
  messages: string[];
}

/** 명령들을 차례로 적용한 새 스키마를 돌려준다. 하나라도 실패하면 CommandError. 새 테이블은 빈 자리에 배치한다. */
export function applyCommands(input: Schema, commands: Command[]): CommandResult {
  const schema = cloneSchema(input);
  const created: string[] = [];
  const messages = commands.map((command, i) => {
    try {
      return applyOne(schema, command, created);
    } catch (e) {
      throw new CommandError(i, e instanceof Error ? e.message : String(e));
    }
  });
  placeNewTables(schema, created.filter((id) => findTable(schema, id)));
  return { schema, messages };
}

/** AI가 읽기 좋은 형태의 스키마 요약 (id 없이 이름만) */
export function describeSchema(schema: Schema) {
  return {
    tables: schema.tables.map((t) => ({
      name: t.name,
      logicalName: t.logicalName || undefined,
      comment: t.comment || undefined,
      columns: t.columns.map((c) => ({
        name: c.name,
        logicalName: c.logicalName || undefined,
        type: c.length ? `${c.type}(${c.length})` : c.type,
        nullable: c.nullable && !c.primaryKey,
        primaryKey: c.primaryKey || undefined,
        unique: c.unique || undefined,
        autoIncrement: c.autoIncrement || undefined,
        default: c.defaultValue ?? undefined,
        onUpdate: c.onUpdate || undefined,
        generated: c.generated?.expression || undefined,
        generatedStored: c.generated?.stored || undefined,
        comment: c.comment || undefined,
      })),
      checks: t.checks?.length ? t.checks.map((k) => ({ name: checkName(t, k), expression: k.expression })) : undefined,
      indexes: t.indexes.length
        ? t.indexes.map((i) => ({
            name: i.name || undefined,
            unique: i.unique,
            ...(i.expression?.trim() ? { expression: i.expression } : { columns: i.columnIds.map((id) => t.columns.find((c) => c.id === id)?.name) }),
            method: i.method || undefined,
            where: i.where || undefined,
          }))
        : undefined,
    })),
    relations: schema.relations.map((r) => {
      const child = findTable(schema, r.fromTableId);
      const parent = findTable(schema, r.toTableId);
      return {
        parent: parent?.name,
        parentColumns: r.toColumnIds.map((id) => parent?.columns.find((c) => c.id === id)?.name),
        child: child?.name,
        childColumns: r.fromColumnIds.map((id) => child?.columns.find((c) => c.id === id)?.name),
        cardinality: r.cardinality,
        onDelete: r.onDelete !== 'NO ACTION' ? r.onDelete : undefined,
      };
    }),
  };
}
