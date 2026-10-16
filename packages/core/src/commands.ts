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
  relationName,
  type Cardinality,
  type Relation,
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
  updateRelation,
} from './operations';
import { addToArea, areaColorClash, createArea, moveToArea, nextAreaColor, paintAreaTables, removeArea, removeFromArea, requireArea, updateArea } from './areas';
import { placeNewTables } from './placement';
import { FEATURE_LABEL, type FeatureKey } from './features';
import type { Dialect } from './dialects/types';
import { addEnumType, canonicalEnumColumns, removeEnumType, requireEnum, typeName, updateEnumType } from './enums';
import { isPrivacyKind, PRIVACY_KINDS, type PrivacyKind } from './privacy';
import { addObject, DB_OBJECT_LABEL, DB_OBJECT_ORDER, findObjectByName, removeObject, updateObject, type DbObjectKind } from './dbObjects';

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
  /** 개인정보 종류 (unique·password·financial·sensitive·personal). null이면 표시 해제. ERD에만 저장 */
  privacy?: PrivacyKind | null;
  /** 개인정보를 암호화(비밀번호는 해시)해서 저장하는지 */
  encrypted?: boolean;
}

export type Command =
  | { op: 'createTable'; name: string; logicalName?: string; comment?: string; color?: string; columns?: ColumnSpec[]; /** 넣을 주제영역 이름 */ area?: string }
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
  /** name: 외래키 이름 — 같은 두 테이블 사이에 관계가 여럿일 때 고른다 */
  | { op: 'dropRelation'; parent: string; child: string; name?: string; dropColumns?: boolean }
  /** 관계 고치기. name: 지금 외래키 이름(여럿일 때 고름), newName: 새 외래키 이름 */
  | { op: 'updateRelation'; parent: string; child: string; name?: string; newName?: string; cardinality?: Cardinality; onDelete?: ReferentialAction; onUpdate?: ReferentialAction }
  // 주제영역 (화면에서 나눠 보는 탭. SQL·DB에는 영향 없음)
  // colorTables(기본 true): 영역 색을 그 영역 테이블 색으로도 칠한다 (공통 테이블은 먼저 들어간 영역 색 유지)
  | { op: 'createArea'; name: string; tables?: string[]; color?: string; colorTables?: boolean }
  | { op: 'updateArea'; area: string; name?: string; color?: string; colorTables?: boolean }
  | { op: 'dropArea'; area: string }
  | { op: 'addToArea'; area: string; tables: string[]; colorTables?: boolean }
  | { op: 'removeFromArea'; area: string; tables: string[] }
  | { op: 'moveToArea'; area: string; tables: string[]; from?: string; colorTables?: boolean }
  // 사용자 정의 타입 (ENUM). 컬럼 타입 칸에 이 이름을 쓴다
  | { op: 'createEnum'; name: string; values: string[]; comment?: string }
  | { op: 'updateEnum'; enum: string; name?: string; values?: string[]; comment?: string }
  | { op: 'dropEnum'; enum: string }
  // DB 객체 (뷰·함수·프로시저·트리거·이벤트·패키지): DDL 그대로. 종류·이름은 DDL에서 읽는다
  | { op: 'createObject'; definition: string; comment?: string }
  /** name(+kind): 고칠 객체, definition: 새 DDL (이름을 바꾸면 그 이름으로) */
  | { op: 'updateObject'; name: string; kind?: DbObjectKind; definition?: string; comment?: string }
  | { op: 'dropObject'; name: string; kind?: DbObjectKind };

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
      patch.type = typeName(`${m[1]} ${m[3]}`);
      patch.length = m[2].replace(/\s+/g, '');
    } else {
      patch.type = typeName(spec.type);
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
  if (spec.privacy !== undefined) {
    if (spec.privacy !== null && !isPrivacyKind(spec.privacy)) throw new Error(`개인정보 종류 "${spec.privacy}"는 없습니다. ${PRIVACY_KINDS.join(', ')} 중 하나 (해제는 null)`);
    patch.privacy = spec.privacy ? { kind: spec.privacy, ...(spec.encrypted ? { encrypted: true } : {}) } : undefined;
  }
  return patch;
}

function applyOne(schema: Schema, command: Command, created: string[], areaOf: Map<string, string>, keepColor: Set<string>, kinds: DbObjectKind[] = DB_OBJECT_ORDER): string {
  switch (command.op) {
    case 'createTable': {
      if (schema.tables.some((t) => eq(t.name, command.name))) throw new Error(`테이블 "${command.name}"이 이미 있습니다`);
      const sameLogical = command.logicalName?.trim() && schema.tables.find((t) => t.logicalName.trim() && t.logicalName.replace(/\s+/g, '') === command.logicalName!.replace(/\s+/g, ''));
      if (sameLogical) throw new Error(`논리명 "${command.logicalName}"은(는) 이미 ${sameLogical.name} 테이블이 쓰고 있습니다`);
      const table = addTable(schema, { name: command.name, logicalName: command.logicalName ?? '', comment: command.comment ?? '', color: command.color });
      for (const spec of command.columns ?? []) addColumn(schema, table.id, columnPatch(spec));
      created.push(table.id);
      if (command.area) areaOf.set(table.id, requireArea(schema, command.area).id);
      if (command.color) keepColor.add(table.id);
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
      const patch = columnPatch(command.changes);
      // 계산식만 바꾸면 저장 방식(STORED/VIRTUAL)은 그대로 둔다
      if (patch.generated && command.changes.generatedStored === undefined && column.generated) patch.generated.stored = column.generated.stored;
      updateColumn(schema, table.id, column.id, patch);
      // 계산식은 그대로 두고 저장 방식만 바꾸는 경우
      if (command.changes.generated === undefined && command.changes.generatedStored !== undefined && column.generated) {
        column.generated = { ...column.generated, stored: command.changes.generatedStored };
      }
      // 개인정보 종류는 그대로 두고 암호화 여부만 바꾸는 경우
      if (command.changes.encrypted !== undefined && command.changes.privacy === undefined) {
        if (!column.privacy) throw new Error(`${table.name}.${column.name}은(는) 개인정보로 표시되지 않았습니다. privacy로 종류를 함께 주세요`);
        column.privacy = { kind: column.privacy.kind, ...(command.changes.encrypted ? { encrypted: true } : {}) };
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
      const relation = relationOf(schema, parent, child, command.name);
      removeRelation(schema, relation.id, command.dropColumns);
      return `${parent.name} → ${child.name} 관계 삭제 (${relationName(schema, relation)})`;
    }
    case 'updateRelation': {
      const parent = tableByName(schema, command.parent);
      const child = tableByName(schema, command.child);
      const relation = relationOf(schema, parent, child, command.name);
      const before = relationName(schema, relation);
      const patch: Partial<Relation> = {};
      if (command.newName !== undefined) patch.name = command.newName;
      if (command.cardinality) patch.cardinality = command.cardinality;
      if (command.onDelete) patch.onDelete = command.onDelete;
      if (command.onUpdate) patch.onUpdate = command.onUpdate;
      updateRelation(schema, relation.id, patch);
      const after = relationName(schema, relation);
      return `${parent.name} → ${child.name} 관계 수정${after !== before ? ` (외래키 이름 ${before} → ${after})` : ''}`;
    }
    case 'createArea': {
      // 다른 영역과 같거나 비슷한 색을 고르면 겹치지 않는 색으로 바꾼다 (영역 색 = 테이블 색이라 겹치면 구분이 안 됨)
      const clash = command.color ? areaColorClash(schema, command.color) : undefined;
      const color = clash ? nextAreaColor(schema) : command.color;
      const area = createArea(schema, { name: command.name, color, tableIds: (command.tables ?? []).map((n) => tableByName(schema, n).id) });
      const painted = command.colorTables === false ? [] : paintAreaTables(schema, area.id, undefined, keepColor);
      const note = clash ? `, ${command.color}은(는) 영역 ${clash.name}과(와) 겹쳐 ${area.color}로` : '';
      return `영역 ${area.name} 생성 (색 ${area.color}, 테이블 ${area.tableIds.length}개${painted.length ? `, 테이블 ${painted.length}개를 영역 색으로` : ''}${note})`;
    }
    case 'updateArea': {
      const old = requireArea(schema, command.area);
      const before = old.name;
      const oldColor = old.color;
      const clash = command.color ? areaColorClash(schema, command.color, old.id) : undefined;
      const area = updateArea(schema, command.area, { name: command.name, color: clash ? nextAreaColor(schema, old.id) : command.color });
      let follow: string[];
      if (command.colorTables === true) {
        // 직접 요청: 이미 있는 영역의 테이블을 모두 영역 색으로 (공통 테이블은 첫 영역 색)
        follow = paintAreaTables(schema, area.id, undefined, keepColor);
      } else {
        // 색을 바꾸면 그 영역 색을 따르던 테이블(예전 영역 색 그대로인 것)도 함께
        follow = command.colorTables !== false && command.color && oldColor !== area.color
          ? area.tableIds.filter((id) => !keepColor.has(id) && findTable(schema, id)?.color === oldColor)
          : [];
        for (const id of follow) findTable(schema, id)!.color = area.color;
      }
      return `영역 ${before}${area.name !== before ? ` → ${area.name}` : ''} 수정${clash ? ` (${command.color}은(는) 영역 ${clash.name}과(와) 겹쳐 ${area.color}로)` : ''}${follow.length ? ` (테이블 ${follow.length}개 색을 ${area.color}로)` : ''}`;
    }
    case 'dropArea': {
      const area = requireArea(schema, command.area);
      removeArea(schema, area.id);
      return `영역 ${area.name} 삭제 (테이블은 남음)`;
    }
    case 'addToArea': {
      const area = requireArea(schema, command.area);
      const tables = command.tables.map((n) => tableByName(schema, n));
      const added = addToArea(schema, area.id, tables.map((t) => t.id));
      const painted = command.colorTables === false ? [] : paintAreaTables(schema, area.id, added, keepColor);
      return `영역 ${area.name}에 ${tables.map((t) => t.name).join(', ')} 추가${painted.length ? ` (테이블 ${painted.length}개를 영역 색으로)` : ''}`;
    }
    case 'removeFromArea': {
      const area = requireArea(schema, command.area);
      const tables = command.tables.map((n) => tableByName(schema, n));
      removeFromArea(schema, area.id, tables.map((t) => t.id));
      return `영역 ${area.name}에서 ${tables.map((t) => t.name).join(', ')} 빼기 (테이블은 남음)`;
    }
    case 'createEnum': {
      const e = addEnumType(schema, { name: command.name, values: command.values, comment: command.comment });
      return `타입 ${e.name} 생성 (ENUM ${e.values.join(', ')})`;
    }
    case 'updateEnum': {
      const e = requireEnum(schema, command.enum);
      const before = e.name;
      updateEnumType(schema, e.id, { name: command.name, values: command.values, comment: command.comment });
      return `타입 ${before}${e.name !== before ? ` → ${e.name}` : ''} 수정 (${e.values.join(', ')})`;
    }
    case 'dropEnum': {
      const e = requireEnum(schema, command.enum);
      const n = removeEnumType(schema, e.id);
      return `타입 ${e.name} 삭제${n ? ` (쓰던 컬럼 ${n}개는 VARCHAR로)` : ''}`;
    }
    case 'createObject': {
      const o = addObject(schema, command.definition, kinds);
      if (command.comment?.trim()) o.comment = command.comment.trim();
      return `${DB_OBJECT_LABEL[o.kind]} ${o.name} 생성`;
    }
    case 'updateObject': {
      const o = findObjectByName(schema, command.name, command.kind);
      const before = `${DB_OBJECT_LABEL[o.kind]} ${o.name}`;
      updateObject(schema, o.id, { definition: command.definition, comment: command.comment }, kinds);
      return `${before} 수정${o.name.toLowerCase() !== command.name.toLowerCase() ? ` (→ ${o.name})` : ''}`;
    }
    case 'dropObject': {
      const o = findObjectByName(schema, command.name, command.kind);
      removeObject(schema, o.id);
      return `${DB_OBJECT_LABEL[o.kind]} ${o.name} 삭제`;
    }
    case 'moveToArea': {
      const area = requireArea(schema, command.area);
      const from = command.from ? requireArea(schema, command.from) : undefined;
      const tables = command.tables.map((n) => tableByName(schema, n));
      moveToArea(schema, area.id, tables.map((t) => t.id), from?.id);
      if (command.colorTables !== false) paintAreaTables(schema, area.id, tables.map((t) => t.id), keepColor);
      return `${tables.map((t) => t.name).join(', ')}을(를) ${from ? `${from.name}에서 ` : ''}영역 ${area.name}(으)로 옮김`;
    }
  }
}

export interface CommandResult {
  schema: Schema;
  messages: string[];
}

/**
 * 이 명령이 쓰는 기능 모듈 (그 DB에 없으면 거절한다). 모두 DB에 있는 기본 기능이면 빈 목록
 * 예) Oracle 프로젝트에 createEnum → ENUM 모듈이 없어 거절
 */
export function commandFeatures(command: Command): FeatureKey[] {
  const out: FeatureKey[] = [];
  const column = (spec?: Partial<ColumnSpec>) => {
    if (spec?.onUpdate?.trim()) out.push('onUpdateTimestamp');
    if (spec?.generated?.trim()) out.push('generated');
  };
  switch (command.op) {
    case 'createEnum':
    case 'updateEnum':
    case 'dropEnum':
      out.push('enum');
      break;
    case 'createObject':
    case 'updateObject':
    case 'dropObject':
      out.push('objects');
      break;
    case 'addCheck':
      out.push('check');
      break;
    case 'addIndex':
      if (command.expression?.trim()) out.push('expressionIndex');
      if (command.where?.trim()) out.push('partialIndex');
      if (command.method?.trim() && command.method.trim().toLowerCase() !== 'btree') out.push('indexMethods');
      break;
    case 'createTable':
      (command.columns ?? []).forEach(column);
      break;
    case 'addColumn':
      column(command.column);
      break;
    case 'updateColumn':
      column(command.changes);
      break;
    case 'addRelation':
    case 'updateRelation':
      if (command.onUpdate && command.onUpdate !== 'NO ACTION') out.push('fkOnUpdate');
      break;
  }
  return out;
}

/** 부모→자식 관계 찾기. 여럿이면 외래키 이름(name)으로 고른다 */
function relationOf(schema: Schema, parent: Table, child: Table, name?: string): Relation {
  const list = schema.relations.filter((r) => r.toTableId === parent.id && r.fromTableId === child.id);
  if (!list.length) throw new Error(`${parent.name} → ${child.name} 관계가 없습니다`);
  if (name?.trim()) {
    const found = list.find((r) => relationName(schema, r).toLowerCase() === name.trim().toLowerCase());
    if (!found) throw new Error(`${parent.name} → ${child.name} 관계 중 외래키 이름 ${name}이(가) 없습니다 (있는 것: ${list.map((r) => relationName(schema, r)).join(', ')})`);
    return found;
  }
  if (list.length > 1) throw new Error(`${parent.name} → ${child.name} 관계가 ${list.length}개입니다. name에 외래키 이름을 넣어 고르세요 (${list.map((r) => relationName(schema, r)).join(', ')})`);
  return list[0];
}

/** 명령들을 차례로 적용한 새 스키마를 돌려준다. 하나라도 실패하면 CommandError. 새 테이블은 빈 자리에 배치한다.
 * dialect를 주면 그 DB에 없는 기능(기능 모듈이 없는 것)을 쓰는 명령은 거절한다. */
export function applyCommands(input: Schema, commands: Command[], dialect?: Pick<Dialect, 'label' | 'features'>): CommandResult {
  if (dialect) {
    commands.forEach((command, i) => {
      const missing = commandFeatures(command).find((k) => !dialect.features[k]);
      if (missing) throw new CommandError(i, `${dialect.label}에는 ${FEATURE_LABEL[missing]}이(가) 없습니다 (이 프로젝트 DB에서 쓸 수 없는 기능)`);
      if (command.op === 'addIndex' && command.method?.trim() && dialect.features.indexMethods && !dialect.features.indexMethods.methods.includes(command.method.trim().toLowerCase()) && command.method.trim().toLowerCase() !== 'btree') {
        throw new CommandError(i, `${dialect.label}에는 ${command.method} 인덱스 방식이 없습니다 (있는 방식: ${dialect.features.indexMethods.methods.join(', ')})`);
      }
    });
  }
  const schema = cloneSchema(input);
  const created: string[] = [];
  const areaOf = new Map<string, string>();
  // 이번 명령에서 색을 직접 정한 테이블 (영역 색으로 덮지 않는다)
  const keepColor = new Set<string>();
  const messages = commands.map((command, i) => {
    try {
      return applyOne(schema, command, created, areaOf, keepColor, dialect?.features.objects?.kinds);
    } catch (e) {
      throw new CommandError(i, e instanceof Error ? e.message : String(e));
    }
  });
  placeNewTables(schema, created.filter((id) => findTable(schema, id)));
  // 영역을 지정해 만든 새 테이블: 영역에 넣고 영역 안 테이블 아래에 놓는다
  const byArea = new Map<string, string[]>();
  for (const [tableId, areaId] of areaOf) if (findTable(schema, tableId) && schema.areas?.some((a) => a.id === areaId)) byArea.set(areaId, [...(byArea.get(areaId) ?? []), tableId]);
  for (const [areaId, ids] of byArea) paintAreaTables(schema, areaId, addToArea(schema, areaId, ids), keepColor);
  // ENUM을 쓰는 컬럼의 타입은 ENUM에 적힌 이름 그대로 (대소문자·따옴표가 달라도 같은 타입)
  canonicalEnumColumns(schema);
  return { schema, messages };
}

/** AI가 읽기 좋은 형태의 스키마 요약 (id 없이 이름만) */
export function describeSchema(schema: Schema) {
  return {
    tables: schema.tables.map((t) => ({
      name: t.name,
      logicalName: t.logicalName || undefined,
      comment: t.comment || undefined,
      /** 화면의 테이블 색 (없으면 기본색) */
      color: t.color || undefined,
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
        privacy: c.privacy?.kind,
        encrypted: c.privacy?.encrypted || undefined,
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
        name: relationName(schema, r),
        parent: parent?.name,
        parentColumns: r.toColumnIds.map((id) => parent?.columns.find((c) => c.id === id)?.name),
        child: child?.name,
        childColumns: r.fromColumnIds.map((id) => child?.columns.find((c) => c.id === id)?.name),
        cardinality: r.cardinality,
        onDelete: r.onDelete !== 'NO ACTION' ? r.onDelete : undefined,
        onUpdate: r.onUpdate !== 'NO ACTION' ? r.onUpdate : undefined,
      };
    }),
    // 사용자 정의 타입 (ENUM): 컬럼 type에 이 이름을 쓴다
    enums: schema.enums?.length ? schema.enums.map((e) => ({ name: e.name, values: e.values, comment: e.comment || undefined })) : undefined,
    // DB 객체: 종류·이름만 (DDL 전체는 get_db_objects로 읽는다)
    objects: schema.objects?.length ? schema.objects.map((o) => ({ kind: o.kind, name: o.name, ...(o.table ? { table: o.table } : {}), ...(o.comment ? { comment: o.comment } : {}) })) : undefined,
    // 주제영역: 이름과 들어 있는 테이블 (화면에서 나눠 보는 탭)
    areas: schema.areas?.length
      ? schema.areas.map((a) => ({ name: a.name, color: a.color, tables: a.tableIds.map((id) => findTable(schema, id)?.name).filter(Boolean) }))
      : undefined,
  };
}
