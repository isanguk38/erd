import { describe, expect, it } from 'vitest';
import { applyCommands, cloneSchema, diffSchemas, emptySchema, generateStatements, getDialect, lintSchema, parseDdl, removeColumn, type Schema } from '../src';

function base(): Schema {
  return applyCommands(emptySchema(), [
    { op: 'createTable', name: 'customer', columns: [
      { name: 'id', type: 'BIGINT', primaryKey: true },
      { name: 'email', type: 'VARCHAR(100)' },
      { name: 'deleted_at', type: 'TIMESTAMP' },
    ] },
  ]).schema;
}

/** base → (식 인덱스 추가) 마이그레이션 SQL */
function sqlFor(dialect: string, index: { expression: string; unique?: boolean; method?: string; where?: string }) {
  const before = base();
  const after = applyCommands(before, [{ op: 'addIndex', table: 'customer', name: 'ix_expr', ...index }]).schema;
  const d = getDialect(dialect as never);
  const diff = diffSchemas(before, after, d);
  return generateStatements(diff, d, new Set(diff.changes.map((c) => c.id))).map((s) => s.sql);
}

describe('식(expression) 인덱스', () => {
  it('DB 종류별 CREATE INDEX', () => {
    expect(sqlFor('postgresql', { expression: 'lower(email)', unique: true, where: 'deleted_at IS NULL' })).toEqual([
      'CREATE UNIQUE INDEX ix_expr ON customer (lower(email)) WHERE deleted_at IS NULL',
    ]);
    expect(sqlFor('postgresql', { expression: "to_tsvector('simple', email)", method: 'gin' })).toEqual([
      "CREATE INDEX ix_expr ON customer USING gin (to_tsvector('simple', email))",
    ]);
    expect(sqlFor('mysql', { expression: '(lower(`email`))' })).toEqual(['CREATE INDEX `ix_expr` ON `customer` ((lower(`email`)))']);
    expect(sqlFor('oracle', { expression: 'UPPER("EMAIL")' })[0]).toMatch(/^CREATE INDEX .*ix_expr.* ON .*customer.* \(UPPER\("EMAIL"\)\)$/i);
    expect(sqlFor('mssql', { expression: 'email', where: 'deleted_at IS NULL' })[0]).toMatch(/\(\[email\]\)|\(email\)/);
  });

  it('식이 같으면(공백·따옴표·형 변환 차이) 변경 없음, 다르면 삭제 후 생성', () => {
    const a = applyCommands(base(), [{ op: 'addIndex', table: 'customer', name: 'ix_l', expression: "(email->>'x')" }]).schema;
    const b = cloneSchema(a);
    b.tables[0].indexes[0].expression = "((email ->> 'x'::text))";
    expect(diffSchemas(a, b, getDialect('postgresql')).changes).toEqual([]);
    b.tables[0].indexes[0].expression = "(email->>'y')";
    expect(diffSchemas(a, b, getDialect('postgresql')).changes.map((c) => c.kind)).toEqual(['dropIndex', 'addIndex']);
  });

  it('컬럼을 지워도 식 인덱스는 남고, 중복 인덱스 검사에서 빠진다', () => {
    const s = applyCommands(base(), [
      { op: 'addIndex', table: 'customer', name: 'ix_a', expression: 'lower(email)' },
      { op: 'addIndex', table: 'customer', name: 'ix_b', expression: 'upper(email)' },
    ]).schema;
    expect(lintSchema(s, 'postgresql').filter((i) => i.rule === 'duplicate-index')).toEqual([]);
    removeColumn(s, s.tables[0].id, s.tables[0].columns.find((c) => c.name === 'deleted_at')!.id);
    expect(s.tables[0].indexes).toHaveLength(2);
  });

  it('DDL 가져오기: PostgreSQL 식·GIN·부분 인덱스', () => {
    const { schema, warnings } = parseDdl(
      `CREATE TABLE product (id BIGINT PRIMARY KEY, name TEXT, metadata JSONB, deleted_at TIMESTAMP);
       CREATE INDEX idx_product_search ON product USING gin (to_tsvector('simple', name));
       CREATE INDEX idx_product_shipping ON public.product ((metadata ->> 'shipping_method'));
       CREATE UNIQUE INDEX ux_product_name ON product (name) WHERE deleted_at IS NULL;
       CREATE INDEX ix_product_name ON product (name);`,
      { dialect: 'postgresql' },
    );
    expect(warnings).toEqual([]);
    const idx = Object.fromEntries(schema.tables[0].indexes.map((i) => [i.name, i]));
    expect(idx.idx_product_search).toMatchObject({ columnIds: [], method: 'gin', expression: "to_tsvector('simple', name)" });
    expect(idx.idx_product_shipping).toMatchObject({ columnIds: [], expression: "(metadata ->> 'shipping_method')" });
    expect(idx.ux_product_name).toMatchObject({ unique: true, where: 'deleted_at IS NULL' });
    expect(idx.ux_product_name.columnIds).toHaveLength(1);
    expect(idx.ix_product_name.expression).toBeUndefined();
  });

  it('DDL 가져오기: MySQL 함수 인덱스 (CREATE TABLE 안·밖)', () => {
    const { schema } = parseDdl(
      'CREATE TABLE `member` (`id` BIGINT PRIMARY KEY, `email` VARCHAR(100), INDEX `ix_lower` ((lower(`email`)))) ENGINE=InnoDB;\n' +
        'CREATE INDEX `ix_prefix` ON `member` (`email`(10));',
      { dialect: 'mysql' },
    );
    const idx = Object.fromEntries(schema.tables[0].indexes.map((i) => [i.name, i]));
    expect(idx.ix_lower).toMatchObject({ columnIds: [], expression: '(lower(`email`))' });
    expect(idx.ix_prefix.expression).toBeUndefined();
    expect(idx.ix_prefix.columnIds).toHaveLength(1);
  });

  it('MCP 명령: expression 또는 columns가 필요하다', () => {
    expect(() => applyCommands(base(), [{ op: 'addIndex', table: 'customer' }])).toThrow(/columns|expression/);
    const { messages } = applyCommands(base(), [{ op: 'addIndex', table: 'customer', expression: 'lower(email)' }]);
    expect(messages[0]).toContain('식 인덱스');
  });
});
