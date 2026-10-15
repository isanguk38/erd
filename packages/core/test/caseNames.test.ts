import { describe, expect, it } from 'vitest';
import { applyChanges, applyCommands, emptySchema, getDialect, planPull, planPush, syncedBaseline, type Schema } from '../src';

const dialect = getDialect('mysql');
/** DB에서 읽은 것처럼 (id가 DB 이름) */
const fromDb = (s: Schema): Schema => ({ ...structuredClone(s), tables: s.tables.map((t) => ({ ...structuredClone(t), id: `db_t_${t.name}`, columns: t.columns.map((c) => ({ ...c, id: `db_c_${t.name}.${c.name}` })) })) });

describe('대소문자만 다른 이름', () => {
  // MySQL(리눅스)은 TB_TAX와 tb_tax를 서로 다른 테이블로 둘 수 있다
  // (ERD 명령은 대소문자만 다른 테이블을 막으므로 따로 만들어 합친다)
  const part = (cmds: Parameters<typeof applyCommands>[1]) => applyCommands(emptySchema(), cmds).schema.tables;
  const db = fromDb({
    ...emptySchema(),
    objects: [],
    tables: [
      ...part([{ op: 'createTable', name: 'TB_TAX', columns: [{ name: 'NO', type: 'VARCHAR(200)', primaryKey: true }, { name: 'NO_TAX', type: 'VARCHAR(15)' }] }]),
      ...part([{ op: 'createTable', name: 'tb_tax', columns: [{ name: 'no', type: 'VARCHAR(20)', primaryKey: true }, { name: 'no_tax', type: 'CHAR(15)' }] }]),
      ...part([{ op: 'createTable', name: 'TB_PAYMENT', columns: [{ name: 'ID', type: 'BIGINT', primaryKey: true }] }]),
    ],
  });

  it('TB_TAX와 tb_tax는 각각 짝지어, 다시 가져와도 차이가 없고 서로 섞이지 않는다', () => {
    const erd = applyChanges({ ...emptySchema(), objects: [] }, planPull({ ...emptySchema(), objects: [] }, db, { dialect }).diff);
    expect(erd.tables.map((t) => t.name).sort()).toEqual(['TB_PAYMENT', 'TB_TAX', 'tb_tax']);
    // 기준 시점 없이 다시 가져오기 → 0건 (예전에는 TB_TAX가 tb_tax로 합쳐져 이름·컬럼이 바뀌었다)
    expect(planPull(erd, db, { dialect }).diff.changes.map((c) => c.summary)).toEqual([]);
    const baseline = syncedBaseline(db, erd);
    expect(planPull(erd, db, { dialect, baseline }).diff.changes).toEqual([]);
    expect(planPush(erd, db, { dialect, baseline }).diff.changes).toEqual([]);
    // 반영해도 그대로
    const again = applyChanges(erd, planPull(erd, db, { dialect }).diff);
    expect(again.tables.map((t) => `${t.name}:${t.columns.map((c) => `${c.name} ${c.type}(${c.length})`).join(',')}`).sort()).toEqual([
      'TB_PAYMENT:ID BIGINT()',
      'TB_TAX:NO VARCHAR(200),NO_TAX VARCHAR(15)',
      'tb_tax:no VARCHAR(20),no_tax CHAR(15)',
    ]);
  });

  it('대소문자만 다르고 하나뿐이면 지금처럼 같은 테이블로 본다 (ERD member ↔ DB MEMBER)', () => {
    const erd = applyCommands({ ...emptySchema(), objects: [] }, [{ op: 'createTable', name: 'member', columns: [{ name: 'member_id', type: 'BIGINT', primaryKey: true }] }]).schema;
    const upper = fromDb(applyCommands(emptySchema(), [{ op: 'createTable', name: 'MEMBER', columns: [{ name: 'MEMBER_ID', type: 'BIGINT', primaryKey: true }] }]).schema);
    expect(planPull(erd, upper, { dialect }).diff.changes.map((c) => c.summary)).toEqual(['테이블 이름 변경 member → MEMBER', 'MEMBER.MEMBER_ID 변경: 이름 member_id → MEMBER_ID']);
  });
});
