import { describe, expect, it } from 'vitest';
import { addTable, applyCommands, applyTemplate, emptySchema, generateCreateSql, getDialect, sampleTemplates, sanitizeTemplateSettings } from '../src';

const [snake, camel, audit] = sampleTemplates();

describe('컬럼 템플릿', () => {
  it('빈 새 테이블에 템플릿을 넣으면 앞/뒤 순서대로 들어가고 SQL로 나온다', () => {
    const s = emptySchema();
    const t = addTable(s, { name: 'coupon' });
    const r = applyTemplate(s, t.id, snake);
    expect(r).toEqual({ added: ['id', 'created_at', 'updated_at'], skipped: [] });
    expect(s.tables[0].columns.map((c) => c.name)).toEqual(['id', 'created_at', 'updated_at']);
    const id = s.tables[0].columns[0];
    expect([id.primaryKey, id.autoIncrement, id.nullable]).toEqual([true, true, false]);
    const sql = generateCreateSql(s, getDialect('mysql'));
    expect(sql).toContain('`id` BIGINT NOT NULL AUTO_INCREMENT');
    expect(sql).toContain('`created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP');
  });

  it('기존 테이블: 같은 이름 컬럼은 건너뛰고, 기본키가 이미 있으면 템플릿 기본키는 넣지 않는다. 기존 컬럼은 그대로', () => {
    const s = applyCommands(emptySchema(), [
      { op: 'createTable', name: 'member', columns: [
        { name: 'member_id', type: 'BIGINT', primaryKey: true },
        { name: 'email', type: 'VARCHAR(100)' },
        { name: 'CREATED_AT', type: 'DATETIME' },
      ] },
    ]).schema;
    const before = structuredClone(s.tables[0].columns);
    const r = applyTemplate(s, s.tables[0].id, snake);
    expect(r).toEqual({ added: ['updated_at'], skipped: ['id', 'created_at'] });
    expect(s.tables[0].columns.map((c) => c.name)).toEqual(['member_id', 'email', 'CREATED_AT', 'updated_at']);
    expect(s.tables[0].columns.slice(0, 3)).toEqual(before);
    expect(s.tables[0].columns.filter((c) => c.primaryKey)).toHaveLength(1);
  });

  it('여러 템플릿을 이어서 넣을 수 있고, 두 번 넣어도 중복되지 않는다', () => {
    const s = emptySchema();
    const t = addTable(s, { name: 'board' });
    applyTemplate(s, t.id, camel);
    applyTemplate(s, t.id, audit);
    expect(applyTemplate(s, t.id, camel).added).toEqual([]);
    expect(s.tables[0].columns.map((c) => c.name)).toEqual(['id', 'createdAt', 'updatedAt', 'created_by', 'updated_by', 'deleted_yn']);
    // 템플릿을 넣을 때마다 컬럼 id는 새로 만든다
    expect(new Set(s.tables[0].columns.map((c) => c.id)).size).toBe(6);
  });

  it('저장할 때 모양이 이상한 값은 정리한다', () => {
    const v = sanitizeTemplateSettings({
      templates: [{ id: 'a', name: '', top: [{ name: ' id ', type: 'bigint', primaryKey: true }, { type: 'INT' }], bottom: 'x' }, null],
      defaultTemplateId: 'nope',
    });
    expect(v.templates[0]).toMatchObject({ id: 'a', name: '이름 없는 템플릿', bottom: [] });
    expect(v.templates[0].top).toHaveLength(1);
    expect(v.templates[0].top[0]).toMatchObject({ name: 'id', type: 'bigint', primaryKey: true, nullable: true, defaultValue: null });
    expect(v.templates).toHaveLength(2);
    expect(v.defaultTemplateId).toBeNull();
    expect(sanitizeTemplateSettings({ templates: [snake], defaultTemplateId: snake.id }).defaultTemplateId).toBe(snake.id);
  });
});
