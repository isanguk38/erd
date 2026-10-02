// 테이블 복사·붙여넣기. 붙여넣으면 모든 id를 새로 만들고, 이름이 겹치면 _2, _3을 붙인다.

import { newId, type Relation, type Schema, type Table } from './model';
import { uniqueTableName } from './operations';

export interface Clip {
  kind: 'erd-tables';
  version: 1;
  tables: Table[];
  /** 복사한 테이블이 자식(FK를 가진 쪽)인 관계 */
  relations: Relation[];
}

export function copyTables(schema: Schema, tableIds: string[]): Clip {
  const ids = new Set(tableIds);
  return {
    kind: 'erd-tables',
    version: 1,
    tables: structuredClone(schema.tables.filter((t) => ids.has(t.id))),
    relations: structuredClone(schema.relations.filter((r) => ids.has(r.fromTableId))),
  };
}

export function isClip(value: unknown): value is Clip {
  const v = value as Clip | null;
  return Boolean(v && v.kind === 'erd-tables' && Array.isArray(v.tables) && Array.isArray(v.relations));
}

/**
 * 붙여넣기. 복사한 테이블끼리의 관계는 새 테이블끼리 다시 잇고,
 * 복사하지 않은 부모를 가리키던 관계는 그 부모가 이 ERD에 있으면 그대로 잇는다 (없으면 FK 컬럼만 남는다).
 * 새로 만든 테이블 id를 돌려준다.
 */
export function pasteTables(schema: Schema, clip: Clip, offset = { x: 40, y: 40 }): string[] {
  const tableMap = new Map<string, string>();
  const columnMap = new Map<string, string>();
  const created: Table[] = [];
  for (const source of clip.tables) {
    const table = structuredClone(source);
    table.id = newId('tbl');
    tableMap.set(source.id, table.id);
    table.name = uniqueTableName({ ...schema, tables: [...schema.tables, ...created] }, source.name);
    table.position = { x: source.position.x + offset.x, y: source.position.y + offset.y };
    for (const c of table.columns) {
      const id = newId('col');
      columnMap.set(c.id, id);
      c.id = id;
    }
    table.indexes = table.indexes.map((i) => ({ ...i, id: newId('idx'), name: i.name ? uniqueIndexName(i.name, schema) : '', columnIds: i.columnIds.map((cid) => columnMap.get(cid) ?? cid) }));
    created.push(table);
  }
  schema.tables.push(...created);

  for (const source of clip.relations) {
    const fromTableId = tableMap.get(source.fromTableId);
    if (!fromTableId) continue;
    const copiedParent = tableMap.get(source.toTableId);
    const parent = copiedParent ? created.find((t) => t.id === copiedParent) : schema.tables.find((t) => t.id === source.toTableId && !created.includes(t));
    if (!parent) continue;
    const toColumnIds = source.toColumnIds.map((cid) => (copiedParent ? columnMap.get(cid) ?? cid : cid));
    if (!toColumnIds.every((cid) => parent.columns.some((c) => c.id === cid))) continue;
    schema.relations.push({
      ...structuredClone(source),
      id: newId('rel'),
      name: '',
      fromTableId,
      fromColumnIds: source.fromColumnIds.map((cid) => columnMap.get(cid) ?? cid),
      toTableId: parent.id,
      toColumnIds,
    });
  }
  return created.map((t) => t.id);
}

/** 인덱스 이름은 DB 전체에서 겹치면 안 되는 경우가 많아 이름이 있으면 뒤에 번호를 붙인다 */
function uniqueIndexName(name: string, schema: Schema): string {
  const used = new Set(schema.tables.flatMap((t) => t.indexes.map((i) => i.name)));
  if (!used.has(name)) return name;
  for (let i = 2; ; i++) if (!used.has(`${name}_${i}`)) return `${name}_${i}`;
}
