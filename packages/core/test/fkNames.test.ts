import { describe, expect, it } from 'vitest';
import { applyCommands, connectTables, copyTables, describeSchema, emptySchema, generateCreateSql, getDialect, lintSchema, parseDdl, pasteTables, relationName, updateRelation, type Schema } from '../src';

const id = (s: Schema, name: string) => s.tables.find((t) => t.name === name)!.id;
const fkNames = (sql: string) => [...sql.matchAll(/ADD CONSTRAINT "?`?([\w]+)/g)].map((m) => m[1]);

// 같은 두 테이블 사이 외래키 둘 (이름 없는 DDL로 들어온 경우)
const LIAR = `
CREATE TABLE hand_player (hand_player_id BIGINT PRIMARY KEY);
CREATE TABLE liar_accusation (
  liar_accusation_id BIGINT PRIMARY KEY,
  accuser_hand_player_id BIGINT REFERENCES hand_player (hand_player_id),
  accused_hand_player_id BIGINT REFERENCES hand_player (hand_player_id) ON DELETE CASCADE
);`;

describe('외래키 이름', () => {
  it('같은 두 테이블 사이 외래키가 둘이면 두 번째는 FK 컬럼 이름으로 (DB에서 이름이 겹쳐 실패하지 않게)', () => {
    const { schema } = parseDdl(LIAR, { dialect: 'postgresql' });
    expect(schema.relations).toHaveLength(2);
    expect(schema.relations.map((r) => relationName(schema, r))).toEqual(['fk_liar_accusation_hand_player', 'fk_liar_accusation_accused_hand_player_id']);
    const names = fkNames(generateCreateSql(schema, getDialect('postgresql')));
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
    expect(lintSchema(schema, 'postgresql').some((i) => i.rule === 'duplicate-fk-name')).toBe(false);
    // MCP get_schema에도 이름이 보인다 (AI가 고를 수 있게)
    expect(describeSchema(schema).relations.map((r) => r.name)).toEqual(['fk_liar_accusation_hand_player', 'fk_liar_accusation_accused_hand_player_id']);
  });

  it('새 관계는 만들 때 이름을 저장한다: 다른 관계를 지우거나 더해도 이름이 바뀌지 않음', () => {
    const { schema } = applyCommands(emptySchema(), [
      { op: 'createTable', name: 'member', columns: [{ name: 'member_id', type: 'BIGINT', primaryKey: true }] },
      { op: 'createTable', name: 'orders', columns: [{ name: 'order_id', type: 'BIGINT', primaryKey: true }] },
      { op: 'addRelation', parent: 'member', child: 'orders' },
    ]);
    expect(schema.relations[0].name).toBe('fk_orders_member');
    // 이미 그 이름이 있으면 FK 컬럼 이름으로
    const s = structuredClone(schema);
    s.tables.find((t) => t.name === 'orders')!.columns.push({ ...s.tables[1].columns[0], id: 'col_x', name: 'referrer_member_id', primaryKey: false });
    s.relations.push({ ...s.relations[0], id: 'rel_x', name: '', fromColumnIds: ['col_x'] });
    const second = connectTables(structuredClone(schema), { parentTableId: id(schema, 'member'), childTableId: id(schema, 'member') });
    expect(second.name).toBe('fk_member_member');
    expect(relationName(s, s.relations[1])).toBe('fk_orders_referrer_member_id');
  });

  it('직접 넣은 이름이 겹치면: 바꾸기는 막고, 이미 겹친 것은 설계 검사 오류 + 겹치지 않는 이름 제안', () => {
    const { schema } = applyCommands(emptySchema(), [
      { op: 'createTable', name: 'member', columns: [{ name: 'member_id', type: 'BIGINT', primaryKey: true }] },
      { op: 'createTable', name: 'orders', columns: [{ name: 'order_id', type: 'BIGINT', primaryKey: true }] },
      { op: 'createTable', name: 'review', columns: [{ name: 'review_id', type: 'BIGINT', primaryKey: true }] },
      { op: 'addRelation', parent: 'member', child: 'orders' },
      { op: 'addRelation', parent: 'member', child: 'review' },
    ]);
    // 대소문자만 달라도 같은 이름 (MySQL 등)
    expect(() => updateRelation(structuredClone(schema), schema.relations[1].id, { name: 'FK_ORDERS_MEMBER' })).toThrow(/이미 orders → member/);
    // 예전 데이터처럼 이미 겹쳐 있으면 설계 검사 오류
    const broken = structuredClone(schema);
    broken.relations[1].name = 'fk_orders_member';
    const issue = lintSchema(broken, 'mysql').find((i) => i.rule === 'duplicate-fk-name');
    expect(issue?.severity).toBe('error');
    expect(issue?.fix).toEqual({ kind: 'patchRelation', relationId: broken.relations[1].id, label: 'fk_review_member(으)로', patch: { name: 'fk_review_member' } });
  });

  it('MCP 명령: updateRelation으로 이름 바꾸기, 관계가 여럿이면 name으로 고른다', () => {
    const { schema } = parseDdl(LIAR, { dialect: 'postgresql' });
    expect(() => applyCommands(schema, [{ op: 'dropRelation', parent: 'hand_player', child: 'liar_accusation' }])).toThrow(/2개입니다/);
    const r = applyCommands(schema, [{ op: 'updateRelation', parent: 'hand_player', child: 'liar_accusation', name: 'fk_liar_accusation_accused_hand_player_id', newName: 'fk_liar_accusation_accused' }]);
    expect(r.messages[0]).toContain('fk_liar_accusation_accused_hand_player_id → fk_liar_accusation_accused');
    expect(() => applyCommands(schema, [{ op: 'updateRelation', parent: 'hand_player', child: 'liar_accusation', name: 'fk_liar_accusation_accused_hand_player_id', newName: 'fk_liar_accusation_hand_player' }])).toThrow(/이미/);
    const dropped = applyCommands(schema, [{ op: 'dropRelation', parent: 'hand_player', child: 'liar_accusation', name: 'fk_liar_accusation_hand_player' }]);
    expect(dropped.schema.relations).toHaveLength(1);
  });

  it('붙여넣기한 테이블의 관계도 겹치지 않는 이름', () => {
    const { schema } = applyCommands(emptySchema(), [
      { op: 'createTable', name: 'member', columns: [{ name: 'member_id', type: 'BIGINT', primaryKey: true }] },
      { op: 'createTable', name: 'orders', columns: [{ name: 'order_id', type: 'BIGINT', primaryKey: true }] },
      { op: 'addRelation', parent: 'member', child: 'orders' },
    ]);
    const s = structuredClone(schema);
    pasteTables(s, copyTables(s, [id(s, 'orders')]));
    const names = s.relations.map((r) => relationName(s, r));
    expect(names).toHaveLength(2);
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(2);
  });
});
