import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { applyCommands, diffSchemas, emptySchema, generateStatements, getDialect, normalizeDefinition, parseObjectDdl, planPull, planPush, readSchema, summarizePlan, writeSchema, type Schema } from '../src';

describe('DB 객체 (뷰·함수·프로시저·트리거)', () => {
  it('DDL에서 종류·이름·트리거 테이블을 읽는다 (DB마다 다른 머리말)', () => {
    expect(parseObjectDdl('CREATE VIEW v_top AS SELECT 1')).toEqual({ kind: 'view', name: 'v_top' });
    expect(parseObjectDdl('CREATE OR REPLACE VIEW "public"."V Top" AS SELECT 1')).toEqual({ kind: 'view', name: 'V Top' });
    expect(parseObjectDdl('CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`localhost` SQL SECURITY DEFINER VIEW `v_top` AS select 1')).toEqual({ kind: 'view', name: 'v_top' });
    expect(parseObjectDdl('CREATE MATERIALIZED VIEW mv AS SELECT 1')).toEqual({ kind: 'materializedView', name: 'mv' });
    expect(parseObjectDdl('CREATE OR REPLACE FUNCTION public.touch()\n RETURNS trigger')).toEqual({ kind: 'function', name: 'touch' });
    expect(parseObjectDdl('CREATE DEFINER=`root`@`%` PROCEDURE `reset`() BEGIN END')).toEqual({ kind: 'procedure', name: 'reset' });
    expect(parseObjectDdl('CREATE TRIGGER trg BEFORE UPDATE ON public.player FOR EACH ROW EXECUTE FUNCTION touch()')).toEqual({ kind: 'trigger', name: 'trg', table: 'player' });
    expect(parseObjectDdl('CREATE TRIGGER [dbo].[trg] ON [dbo].[orders] AFTER INSERT AS BEGIN END')).toEqual({ kind: 'trigger', name: 'trg', table: 'orders' });
    expect(parseObjectDdl('CREATE EVENT ev ON SCHEDULE EVERY 1 DAY DO SELECT 1')).toEqual({ kind: 'event', name: 'ev' });
    expect(parseObjectDdl('CREATE OR REPLACE EDITIONABLE PACKAGE BODY "PKG" AS END;')).toEqual({ kind: 'packageBody', name: 'PKG' });
    expect(parseObjectDdl('-- 설명\nCREATE OR ALTER PROCEDURE dbo.p AS SELECT 1')).toEqual({ kind: 'procedure', name: 'p' });
    expect(parseObjectDdl('SELECT 1')).toBe(null);
  });

  it('공백·끝의 ;·DEFINER만 다르면 같은 정의', () => {
    expect(normalizeDefinition('CREATE DEFINER=`a`@`%` VIEW v AS\r\n  SELECT 1;\n')).toBe(normalizeDefinition('CREATE VIEW v AS SELECT 1'));
  });

  it('고친 뷰는 테이블을 바꾸기 전에 지우고 다 바꾼 뒤 다시 만든다. 함수는 뷰·트리거보다 먼저', () => {
    const dialect = getDialect('postgresql');
    const base: Schema = applyCommands(emptySchema(), [
      { op: 'createTable', name: 'player', columns: [{ name: 'player_id', type: 'BIGINT', primaryKey: true }, { name: 'nick', type: 'VARCHAR(20)' }] },
      { op: 'createObject', definition: 'CREATE VIEW v_top AS SELECT nick FROM player' },
    ], dialect).schema;
    const target = applyCommands(base, [
      { op: 'updateColumn', table: 'player', column: 'nick', changes: { type: 'VARCHAR(50)' } },
      { op: 'updateObject', name: 'v_top', definition: 'CREATE VIEW v_top AS SELECT player_id, nick FROM player' },
      { op: 'createObject', definition: 'CREATE TRIGGER trg BEFORE UPDATE ON player FOR EACH ROW EXECUTE FUNCTION touch()' },
      { op: 'createObject', definition: 'CREATE OR REPLACE FUNCTION touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$' },
    ], dialect).schema;
    const sql = generateStatements(diffSchemas(base, target, dialect), dialect).map((s) => s.sql);
    expect(sql[0]).toBe('DROP VIEW IF EXISTS v_top');
    expect(sql[1]).toContain('ALTER COLUMN nick TYPE');
    expect(sql.slice(2).map((s) => /^CREATE (OR REPLACE )?(\w+) (\w+)/.exec(s)!.slice(2).join(' '))).toEqual(['FUNCTION touch', 'VIEW v_top', 'TRIGGER trg']);
  });

  it('PostgreSQL 함수는 지우지 않고 CREATE OR REPLACE로 바꾼다 (트리거가 쓰는 함수), MySQL은 지웠다 다시 만든다', () => {
    const pg = getDialect('postgresql');
    const a = applyCommands(emptySchema(), [{ op: 'createObject', definition: 'CREATE OR REPLACE FUNCTION f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$' }], pg).schema;
    const b = applyCommands(a, [{ op: 'updateObject', name: 'f', definition: 'CREATE OR REPLACE FUNCTION f() RETURNS int LANGUAGE sql AS $$ SELECT 2 $$' }], pg).schema;
    expect(generateStatements(diffSchemas(a, b, pg), pg).map((s) => s.sql)).toEqual(['CREATE OR REPLACE FUNCTION f() RETURNS int LANGUAGE sql AS $$ SELECT 2 $$']);
    const my = getDialect('mysql');
    const c = applyCommands(emptySchema(), [{ op: 'createObject', definition: 'CREATE FUNCTION f() RETURNS INT DETERMINISTIC RETURN 1' }], my).schema;
    const d = applyCommands(c, [{ op: 'updateObject', name: 'f', definition: 'CREATE FUNCTION f() RETURNS INT DETERMINISTIC RETURN 2;' }], my).schema;
    expect(generateStatements(diffSchemas(c, d, my), my).map((s) => s.sql)).toEqual(['DROP FUNCTION IF EXISTS `f`', 'CREATE FUNCTION f() RETURNS INT DETERMINISTIC RETURN 2']);
    // Oracle PL/SQL은 끝의 ;를 남긴다 (뷰는 뺀다)
    const ora = getDialect('oracle');
    const e = applyCommands(emptySchema(), [
      { op: 'createObject', definition: 'CREATE OR REPLACE PROCEDURE p IS BEGIN NULL; END;\n/' },
      { op: 'createObject', definition: 'CREATE OR REPLACE VIEW v AS SELECT 1 AS n FROM dual;' },
    ], ora).schema;
    expect(generateStatements(diffSchemas(emptySchema(), e, ora), ora).map((s) => s.sql)).toEqual(['CREATE OR REPLACE PROCEDURE p IS BEGIN NULL; END;', 'CREATE OR REPLACE VIEW v AS SELECT 1 AS n FROM dual']);
  });

  it('그 DB에 없는 종류는 막고, 객체를 모르는 쪽(예전 앱이 읽은 DB)과는 비교하지 않는다', () => {
    expect(() => applyCommands(emptySchema(), [{ op: 'createObject', definition: 'CREATE EVENT ev ON SCHEDULE EVERY 1 DAY DO SELECT 1' }], getDialect('postgresql'))).toThrow(/이벤트/);
    const pg = getDialect('postgresql');
    const erd = applyCommands(emptySchema(), [
      { op: 'createTable', name: 't', columns: [{ name: 'id', type: 'INT', primaryKey: true }] },
      { op: 'createObject', definition: 'CREATE VIEW v AS SELECT id FROM t' },
    ], pg).schema;
    const unknown: Schema = { ...structuredClone(erd), objects: undefined };
    expect(diffSchemas(unknown, erd, pg).changes.filter((c) => c.kind.endsWith('Object'))).toEqual([]);
    expect(diffSchemas({ ...unknown, objects: [] }, erd, pg).changes.map((c) => c.summary)).toEqual(['뷰 v 생성']);
  });

  it('객체를 가져온 적 없는 ERD(예전 프로젝트): 가져오기에는 DB 객체가 "DB에서 바뀜"으로 나오고, 내보내기는 지우지 않는다', () => {
    const pg = getDialect('postgresql');
    const db = applyCommands(emptySchema(), [
      { op: 'createTable', name: 't', columns: [{ name: 'id', type: 'INT', primaryKey: true }] },
      { op: 'createObject', definition: 'CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$' },
    ], pg).schema;
    const erd: Schema = { ...structuredClone(db), objects: undefined };
    // 기준 시점이 있어도 (객체가 들어 있는 DB 구조로 저장된 것)
    for (const baseline of [undefined, structuredClone(db)]) {
      const pull = planPull(erd, db, { dialect: pg, baseline });
      expect(pull.diff.changes.map((c) => c.summary)).toEqual(['함수 f 생성']);
      expect(summarizePlan(pull)).toMatchObject({ db: baseline ? 1 : 0, erd: 0 });
      expect(pull.defaultSelected.size).toBe(1);
      expect(planPush(erd, db, { dialect: pg, baseline }).diff.changes).toEqual([]);
    }
  });

  it('기준 시점에 객체 목록이 없을 때(객체 기능 전에 맞춤): ERD에서 만든 객체는 내보내기 배지, DB에만 있는 객체는 가져오기 배지', () => {
    const pg = getDialect('postgresql');
    const db = applyCommands(emptySchema(), [
      { op: 'createTable', name: 't', columns: [{ name: 'id', type: 'INT', primaryKey: true }] },
      { op: 'createObject', definition: 'CREATE VIEW v_db AS SELECT 1' },
    ], pg).schema;
    const erd = applyCommands({ ...structuredClone(db), objects: [] }, [{ op: 'createObject', definition: 'CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$' }], pg).schema;
    const baseline: Schema = { ...structuredClone(db), objects: undefined };
    const pull = planPull(erd, db, { dialect: pg, baseline });
    const origin = (p: typeof pull, summary: string) => p.origins[p.diff.changes.find((c) => c.summary === summary)!.id];
    expect(origin(pull, '함수 f 삭제')).toBe('erd');
    expect(origin(pull, '뷰 v_db 생성')).toBe('db');
    expect(summarizePlan(pull)).toMatchObject({ erd: 1, db: 1, unknown: 0 });
    const push = planPush(erd, db, { dialect: pg, baseline });
    expect(origin(push, '함수 f 생성')).toBe('erd');
    expect(push.defaultSelected.has(push.diff.changes.find((c) => c.summary === '함수 f 생성')!.id)).toBe(true);
  });

  it('문서(Yjs)에 저장하고 읽으면 같다', () => {
    const doc = new Y.Doc();
    const s = applyCommands(emptySchema(), [{ op: 'createObject', definition: 'CREATE TRIGGER trg BEFORE INSERT ON t FOR EACH ROW SET NEW.a = 1', comment: '설명' }], getDialect('mysql')).schema;
    writeSchema(doc, s);
    expect(readSchema(doc).objects).toEqual(s.objects);
    // 객체를 모르는 쪽이 저장해도 남는다
    writeSchema(doc, { ...s, objects: undefined });
    expect(readSchema(doc).objects).toHaveLength(1);
  });
});
