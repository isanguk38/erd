import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { applyCommands, cloneSchema, diffSchemas, emptySchema, generateStatements, getDialect, lintSchema, parseDdl, removeColumn, readSchema, writeSchema, type Schema } from '../src';

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
    // 앞부분 길이는 잃지 않게 원문으로 담는다
    expect(idx.ix_prefix.expression).toBe('`email`(10)');
  });

  it('다른 DB로 내보낼 때: MySQL은 식을 괄호로 감싸고, 지원하지 않는 기능은 주의를 단다', () => {
    const empty = emptySchema();
    const pg = applyCommands(empty, [
      { op: 'createTable', name: 'member', columns: [
        { name: 'id', type: 'BIGINT', primaryKey: true },
        { name: 'email', type: 'VARCHAR(100)' },
        { name: 'profile', type: 'JSONB' },
        { name: 'deleted_at', type: 'TIMESTAMP' },
      ] },
      { op: 'addIndex', table: 'member', name: 'ux_email_live', expression: 'lower(email)', unique: true, where: 'deleted_at IS NULL' },
      { op: 'addIndex', table: 'member', name: 'ix_profile', columns: ['profile'], method: 'gin' },
      { op: 'addIndex', table: 'member', name: 'ix_fts', expression: "to_tsvector('simple', email)", method: 'gin' },
    ]).schema;
    const out = (dialect: string) => {
      const d = getDialect(dialect as never);
      const diff = diffSchemas(empty, pg, d);
      const byName = (n: string) => diff.changes.find((c) => c.kind === 'addIndex' && (c as { index: { name: string } }).index.name === n)!;
      const sql = generateStatements(diff, d, new Set(diff.changes.map((c) => c.id))).map((x) => x.sql);
      return { warn: (n: string) => byName(n).warning ?? '', sql };
    };
    const mysql = out('mysql');
    expect(mysql.sql).toContain('CREATE UNIQUE INDEX `ux_email_live` ON `member` ((lower(email)))');
    expect(mysql.warn('ux_email_live')).toContain('부분 인덱스를 지원하지 않아 조건(WHERE deleted_at IS NULL)을 빼고');
    expect(mysql.warn('ix_profile')).toMatch(/gin 방식이 없어.*JSON 컬럼\(profile\)/);
    expect(mysql.warn('ix_fts')).toContain('PostgreSQL 전용 문법');
    expect(out('mariadb').warn('ux_email_live')).toContain('식 인덱스를 지원하지 않습니다');
    expect(out('mssql').warn('ux_email_live')).toContain('식 인덱스를 지원하지 않습니다');
    const postgres = out('postgresql');
    expect(['ux_email_live', 'ix_profile', 'ix_fts'].map(postgres.warn)).toEqual(['', '', '']);
  });

  it('MySQL: FULLTEXT·앞부분 길이·DESC·ON UPDATE를 DDL에서 읽고 같은 문법으로 내보낸다', () => {
    const { schema, warnings } = parseDdl(
      'CREATE TABLE `board` (`id` BIGINT PRIMARY KEY, `title` VARCHAR(200), `body` TEXT, `at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,' +
        ' KEY `ix_prefix` (`title`(20)), KEY `ix_desc` (`at` DESC), FULLTEXT KEY `ft_body` (`body`), CONSTRAINT `ck` CHECK (`id` > 0)) ENGINE=InnoDB;',
      { dialect: 'mysql' },
    );
    expect(warnings).toEqual(['board: CHECK 제약은 가져오지 않습니다']);
    const t = schema.tables[0];
    const idx = Object.fromEntries(t.indexes.map((i) => [i.name, i]));
    expect(idx.ix_prefix.expression).toBe('`title`(20)');
    expect(idx.ix_desc.expression).toBe('`at` DESC');
    expect(idx.ft_body).toMatchObject({ method: 'fulltext' });
    expect(t.columns.find((c) => c.name === 'at')!.onUpdate).toBe('CURRENT_TIMESTAMP');

    const mysql = getDialect('mysql');
    const diff = diffSchemas(emptySchema(), schema, mysql);
    const sql = generateStatements(diff, mysql, new Set(diff.changes.map((c) => c.id))).map((x) => x.sql).join('\n');
    expect(sql).toContain('ON UPDATE CURRENT_TIMESTAMP');
    expect(sql).toContain('CREATE INDEX `ix_prefix` ON `board` (`title`(20))');
    expect(sql).toContain('CREATE INDEX `ix_desc` ON `board` (`at` DESC)');
    expect(sql).toContain('CREATE FULLTEXT INDEX `ft_body` ON `board` (`body`)');

    // PostgreSQL로 내보내면 fulltext는 일반 인덱스 + 주의, ON UPDATE는 비교하지 않는다
    const pg = getDialect('postgresql');
    const pgDiff = diffSchemas(emptySchema(), schema, pg);
    const ft = pgDiff.changes.find((c) => c.kind === 'addIndex' && (c as { index: { name: string } }).index.name === 'ft_body')!;
    expect(ft.warning).toContain('fulltext 방식이 없어');
    expect(generateStatements(pgDiff, pg, new Set([ft.id]))[0].sql).not.toContain('USING');
  });

  it('ON UPDATE를 빼거나 넣으면 MySQL에서만 컬럼 변경으로 본다', () => {
    const a = parseDdl('CREATE TABLE t (id INT PRIMARY KEY, at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP);', { dialect: 'mysql' }).schema;
    const b = cloneSchema(a);
    delete b.tables[0].columns[1].onUpdate;
    expect(diffSchemas(a, b, getDialect('mysql')).changes.map((c) => c.summary)).toEqual(['t.at 변경: 수정 시 값(ON UPDATE)']);
    expect(diffSchemas(a, b, getDialect('postgresql')).changes).toEqual([]);
  });

  it('ON UPDATE는 함께 편집(Y 문서)에 저장했다 읽어도 남고, MCP 명령으로 켜고 끈다', () => {
    const s = applyCommands(emptySchema(), [
      { op: 'createTable', name: 't', columns: [{ name: 'id', type: 'INT', primaryKey: true }, { name: 'at', type: 'TIMESTAMP', nullable: false, default: 'CURRENT_TIMESTAMP', onUpdate: 'current_timestamp' }] },
    ]).schema;
    expect(s.tables[0].columns[1].onUpdate).toBe('CURRENT_TIMESTAMP');
    const doc = new Y.Doc();
    writeSchema(doc, s);
    expect(readSchema(doc).tables[0].columns[1].onUpdate).toBe('CURRENT_TIMESTAMP');
    const off = applyCommands(s, [{ op: 'updateColumn', table: 't', column: 'at', changes: { onUpdate: null } }]).schema;
    writeSchema(doc, off);
    expect(readSchema(doc).tables[0].columns[1].onUpdate).toBeUndefined();
  });

  it('MCP 명령: expression 또는 columns가 필요하다', () => {
    expect(() => applyCommands(base(), [{ op: 'addIndex', table: 'customer' }])).toThrow(/columns|expression/);
    const { messages } = applyCommands(base(), [{ op: 'addIndex', table: 'customer', expression: 'lower(email)' }]);
    expect(messages[0]).toContain('식 인덱스');
  });
});
