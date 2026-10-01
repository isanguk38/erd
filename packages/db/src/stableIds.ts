import type { Schema } from '@erd/core';

/**
 * DB에서 읽은 요소에 이름으로 정해지는 id를 붙인다.
 * 같은 DB를 여러 번 읽어도 id가 같아야, 미리보기에서 고른 변경·이름 변경을
 * 다음 요청(실행)에서도 그대로 가리킬 수 있다.
 */
export function stabilizeIds(schema: Schema): Schema {
  const tableIds = new Map<string, string>();
  const columnIds = new Map<string, string>();
  for (const t of schema.tables) {
    const tid = `db_t_${t.name}`;
    tableIds.set(t.id, tid);
    t.id = tid;
    for (const c of t.columns) {
      const cid = `db_c_${t.name}.${c.name}`;
      columnIds.set(c.id, cid);
      c.id = cid;
    }
    for (const i of t.indexes) {
      i.id = `db_i_${t.name}.${i.name}`;
      i.columnIds = i.columnIds.map((id) => columnIds.get(id) ?? id);
    }
  }
  for (const r of schema.relations) {
    r.fromTableId = tableIds.get(r.fromTableId) ?? r.fromTableId;
    r.toTableId = tableIds.get(r.toTableId) ?? r.toTableId;
    r.fromColumnIds = r.fromColumnIds.map((id) => columnIds.get(id) ?? id);
    r.toColumnIds = r.toColumnIds.map((id) => columnIds.get(id) ?? id);
    const from = schema.tables.find((t) => t.id === r.fromTableId);
    r.id = `db_r_${from?.name ?? ''}.${r.name}`;
  }
  return schema;
}
