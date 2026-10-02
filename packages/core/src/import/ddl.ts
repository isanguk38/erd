// DDL(CREATE TABLE 등)을 읽어 스키마 모델로 바꾼다. MySQL과 PostgreSQL 문법을 함께 지원한다.
// 지원: CREATE TABLE, CREATE [UNIQUE] INDEX, ALTER TABLE ... ADD (컬럼/제약조건), COMMENT ON TABLE/COLUMN
// 나머지 문장(INSERT, SET, DROP 등)은 건너뛰고 warnings에 남긴다.

import type { DialectId } from '../dialects/types';
import {
  createColumn,
  createIndex,
  createRelation,
  createTable,
  emptySchema,
  type Column,
  type ReferentialAction,
  type Schema,
  type Table,
} from '../model';
import { splitStatements, tokenize, type Token } from './tokenizer';

export interface DdlImportOptions {
  /** 'auto'면 문법을 보고 추측한다 */
  dialect?: DialectId | 'auto';
  /** DB 코멘트를 어디에 넣을지. 국내 관례상 기본은 논리명. */
  commentAs?: 'logicalName' | 'comment';
  /**
   * DDL에 없는 테이블을 참조하는 외래키를 풀 때 쓰는 기존 스키마 (지금 ERD에 합칠 때).
   * 참조된 테이블은 결과에 그대로 복사된다.
   */
  context?: Schema;
}

export interface DdlImportResult {
  schema: Schema;
  dialect: DialectId;
  warnings: string[];
}

interface PendingForeignKey {
  name: string;
  fromTable: string;
  fromColumns: string[];
  toTable: string;
  toColumns: string[];
  onDelete: ReferentialAction;
  onUpdate: ReferentialAction;
}

const INTEGER_TYPES = new Set(['INT', 'INTEGER', 'BIGINT', 'SMALLINT', 'MEDIUMINT', 'TINYINT']);
const SERIAL: Record<string, string> = { SERIAL: 'INTEGER', BIGSERIAL: 'BIGINT', SMALLSERIAL: 'SMALLINT', SERIAL4: 'INTEGER', SERIAL8: 'BIGINT', SERIAL2: 'SMALLINT' };
const STOP_WORDS = new Set([
  'NOT', 'NULL', 'DEFAULT', 'AUTO_INCREMENT', 'AUTOINCREMENT', 'PRIMARY', 'UNIQUE', 'KEY', 'COMMENT', 'REFERENCES',
  'GENERATED', 'CHARACTER', 'CHARSET', 'COLLATE', 'ON', 'CHECK', 'CONSTRAINT', 'AS', 'UNSIGNED', 'ZEROFILL', 'IDENTITY',
  'VISIBLE', 'INVISIBLE', 'STORED', 'VIRTUAL', 'SIGNED',
]);

class Cursor {
  pos = 0;
  constructor(private readonly tokens: Token[], private readonly sql: string) {}

  get done(): boolean { return this.pos >= this.tokens.length; }
  peek(offset = 0): Token | undefined { return this.tokens[this.pos + offset]; }
  next(): Token {
    const t = this.tokens[this.pos++];
    if (!t) throw new Error('문장이 예상보다 일찍 끝났습니다');
    return t;
  }
  is(word: string, offset = 0): boolean {
    const t = this.peek(offset);
    return !!t && t.type === 'ident' && t.value.toUpperCase() === word;
  }
  isPunct(value: string, offset = 0): boolean {
    const t = this.peek(offset);
    return !!t && (t.type === 'punct' || t.type === 'op') && t.value === value;
  }
  accept(...words: string[]): boolean {
    if (!words.every((w, i) => this.is(w, i))) return false;
    this.pos += words.length;
    return true;
  }
  acceptPunct(value: string): boolean {
    if (!this.isPunct(value)) return false;
    this.pos++;
    return true;
  }
  expectPunct(value: string): void {
    if (!this.acceptPunct(value)) throw new Error(`'${value}'가 필요합니다 (위치: ${this.peek()?.value ?? '끝'})`);
  }
  /** 식별자 하나 (따옴표 포함) */
  identifier(): string {
    const t = this.next();
    if (t.type !== 'ident' && t.type !== 'quoted' && t.type !== 'string') throw new Error(`이름이 필요합니다 (위치: ${t.value})`);
    return t.value;
  }
  /** schema.table 형태면 마지막 부분만 쓴다 */
  qualifiedName(): string {
    let name = this.identifier();
    while (this.isPunct('.')) {
      this.pos++;
      name = this.identifier();
    }
    return name;
  }
  /** 현재 위치의 ( ... )를 통째로 건너뛰고 안쪽 원문을 돌려준다 */
  skipParens(): string {
    const open = this.next();
    if (open.value !== '(') throw new Error(`'('가 필요합니다 (위치: ${open.value})`);
    let depth = 1;
    let last = open;
    while (depth > 0) {
      last = this.next();
      if (last.value === '(' && last.type === 'punct') depth++;
      if (last.value === ')' && last.type === 'punct') depth--;
    }
    return this.sql.slice(open.end, last.start).trim();
  }
  /** 콤마 또는 닫는 괄호(같은 깊이)가 나올 때까지 건너뛴다 */
  skipItem(): void {
    while (!this.done && !this.isPunct(',') && !this.isPunct(')')) {
      if (this.isPunct('(')) this.skipParens();
      else this.pos++;
    }
  }
  raw(from: Token, to: Token): string {
    return this.sql.slice(from.start, to.end);
  }
}

export function detectDialect(sql: string): DialectId {
  const pg = /\bSERIAL\b|\bBIGSERIAL\b|COMMENT\s+ON\s+(TABLE|COLUMN)|::|GENERATED\s+(ALWAYS|BY\s+DEFAULT)\s+AS\s+IDENTITY|\bJSONB\b|\bTIMESTAMPTZ\b/i.test(sql);
  const my = /`|\bENGINE\s*=|\bAUTO_INCREMENT\b|\bUNSIGNED\b|\bCHARSET\b/i.test(sql);
  if (pg && !my) return 'postgresql';
  return 'mysql';
}

export function parseDdl(sql: string, options: DdlImportOptions = {}): DdlImportResult {
  const dialect = !options.dialect || options.dialect === 'auto' ? detectDialect(sql) : options.dialect;
  const commentAs = options.commentAs ?? 'logicalName';
  const schema = emptySchema();
  const warnings: string[] = [];
  const tables = new Map<string, Table>();
  const pendingFks: PendingForeignKey[] = [];

  const tableOf = (name: string): Table | undefined => tables.get(name.toLowerCase());
  const borrow = (name: string): Table | undefined => {
    const found = options.context?.tables.find((t) => t.name.toLowerCase() === name.toLowerCase());
    if (!found) return undefined;
    const copy = structuredClone(found);
    tables.set(name.toLowerCase(), copy);
    schema.tables.push(copy);
    return copy;
  };
  const columnOf = (table: Table, name: string): Column | undefined => table.columns.find((c) => c.name.toLowerCase() === name.toLowerCase());
  const setComment = (item: { comment: string; logicalName: string }, value: string) => {
    if (commentAs === 'logicalName') item.logicalName = value;
    else item.comment = value;
  };

  const statements = splitStatements(tokenize(sql, dialect === 'mysql'));
  for (const tokens of statements) {
    const c = new Cursor(tokens, sql);
    const preview = sql.slice(tokens[0].start, Math.min(tokens[0].start + 60, tokens[tokens.length - 1].end)).replace(/\s+/g, ' ');
    try {
      if (c.is('CREATE')) {
        c.pos++;
        c.accept('OR', 'REPLACE');
        c.accept('TEMPORARY') || c.accept('TEMP') || c.accept('UNLOGGED');
        if (c.accept('TABLE')) {
          parseCreateTable(c);
          continue;
        }
        const unique = c.accept('UNIQUE');
        if (c.accept('INDEX')) {
          parseCreateIndex(c, unique);
          continue;
        }
      } else if (c.is('ALTER') && c.is('TABLE', 1)) {
        c.pos += 2;
        parseAlterTable(c);
        continue;
      } else if (c.is('COMMENT') && c.is('ON', 1)) {
        c.pos += 2;
        parseCommentOn(c);
        continue;
      }
      warnings.push(`건너뜀: ${preview}`);
    } catch (e) {
      warnings.push(`읽지 못함: ${preview} (${e instanceof Error ? e.message : e})`);
    }
  }

  // 외래키는 모든 테이블을 읽은 뒤에 연결한다 (참조 테이블이 뒤에 정의될 수 있으므로)
  for (const fk of pendingFks) {
    const from = tableOf(fk.fromTable);
    const to = tableOf(fk.toTable) ?? borrow(fk.toTable);
    if (!from || !to) {
      warnings.push(`외래키 ${fk.name || ''} ${fk.fromTable} → ${fk.toTable}: 테이블을 찾지 못해 건너뜀`);
      continue;
    }
    const toColumns = fk.toColumns.length ? fk.toColumns.map((n) => columnOf(to, n)) : to.columns.filter((col) => col.primaryKey);
    const fromColumns = fk.fromColumns.map((n) => columnOf(from, n));
    if (fromColumns.some((x) => !x) || toColumns.some((x) => !x) || fromColumns.length !== toColumns.length || !fromColumns.length) {
      warnings.push(`외래키 ${fk.name || ''} ${fk.fromTable} → ${fk.toTable}: 컬럼이 맞지 않아 건너뜀`);
      continue;
    }
    const fromIsUnique =
      fromColumns.length === 1 && (fromColumns[0]!.unique || (fromColumns[0]!.primaryKey && from.columns.filter((x) => x.primaryKey).length === 1));
    schema.relations.push(
      createRelation({
        name: fk.name,
        fromTableId: from.id,
        fromColumnIds: fromColumns.map((x) => x!.id),
        toTableId: to.id,
        toColumnIds: toColumns.map((x) => x!.id),
        cardinality: fromIsUnique ? '1:1' : '1:N',
        onDelete: fk.onDelete,
        onUpdate: fk.onUpdate,
      }),
    );
  }

  return { schema, dialect, warnings };

  // ── 문장별 해석 ──────────────────────────────────────────

  function parseCreateTable(c: Cursor) {
    c.accept('IF', 'NOT', 'EXISTS');
    const name = c.qualifiedName();
    if (c.accept('LIKE') || c.is('AS') || !c.isPunct('(')) throw new Error('CREATE TABLE ... LIKE/AS 는 지원하지 않습니다');
    const table = createTable({ name });
    if (tableOf(name)) throw new Error(`${name} 테이블이 이미 있습니다`);
    tables.set(name.toLowerCase(), table);
    schema.tables.push(table);

    c.expectPunct('(');
    while (!c.isPunct(')')) {
      parseTableItem(c, table);
      if (!c.acceptPunct(',')) break;
    }
    c.expectPunct(')');

    // 테이블 옵션: COMMENT='...' 만 사용
    while (!c.done) {
      if (c.accept('COMMENT')) {
        c.acceptPunct('=');
        setComment(table, c.next().value);
      } else if (c.isPunct('(')) c.skipParens();
      else c.pos++;
    }
  }

  function parseTableItem(c: Cursor, table: Table) {
    let constraintName = '';
    if (c.accept('CONSTRAINT')) {
      if (!c.is('PRIMARY') && !c.is('UNIQUE') && !c.is('FOREIGN') && !c.is('CHECK')) constraintName = c.identifier();
    }
    if (c.accept('PRIMARY', 'KEY')) {
      skipIndexType(c);
      const cols = columnList(c);
      for (const n of cols) {
        const col = columnOf(table, n);
        if (col) { col.primaryKey = true; col.nullable = false; }
      }
      if (constraintName && dialect === 'postgresql') table.primaryKeyName = constraintName;
      c.skipItem();
      return;
    }
    if (c.is('UNIQUE') || ((c.is('KEY') || c.is('INDEX')) && !c.isPunct(',', 1))) {
      const unique = c.accept('UNIQUE');
      c.accept('KEY') || c.accept('INDEX');
      let name = constraintName;
      if (!c.isPunct('(') && !c.is('USING')) name = c.identifier();
      const method = skipIndexType(c);
      addIndexFromList(c, table, name, unique, method);
      c.skipItem();
      return;
    }
    if (c.is('FULLTEXT') || c.is('SPATIAL') || c.is('CHECK') || c.is('EXCLUDE')) {
      c.skipItem();
      return;
    }
    if (c.accept('FOREIGN', 'KEY')) {
      let name = constraintName;
      if (!c.isPunct('(')) name = c.identifier();
      const fromColumns = columnList(c);
      pendingFks.push({ name, fromTable: table.name, fromColumns, ...parseReferences(c) });
      c.skipItem();
      return;
    }
    parseColumn(c, table);
  }

  function parseColumn(c: Cursor, table: Table) {
    const column = createColumn({ name: c.identifier(), length: '', nullable: true });
    readType(c, column);

    while (!c.done && !c.isPunct(',') && !c.isPunct(')')) {
      if (c.accept('NOT', 'NULL')) column.nullable = false;
      else if (c.accept('NULL')) column.nullable = true;
      else if (c.accept('DEFAULT')) column.defaultValue = readExpression(c);
      else if (c.accept('AUTO_INCREMENT') || c.accept('AUTOINCREMENT')) column.autoIncrement = true;
      else if (c.accept('PRIMARY', 'KEY') || c.accept('KEY')) { column.primaryKey = true; column.nullable = false; }
      else if (c.accept('UNIQUE')) { c.accept('KEY'); column.unique = true; }
      else if (c.accept('COMMENT')) setComment(column, c.next().value);
      else if (c.accept('REFERENCES')) {
        c.pos--;
        pendingFks.push({ name: '', fromTable: table.name, fromColumns: [column.name], ...parseReferences(c) });
      } else if (c.accept('GENERATED')) {
        if (c.accept('ALWAYS') || c.accept('BY', 'DEFAULT')) { /* 다음 AS로 */ }
        c.accept('ON', 'NULL');
        if (c.accept('AS', 'IDENTITY')) {
          column.autoIncrement = true;
          if (c.isPunct('(')) c.skipParens();
        } else if (c.accept('AS')) {
          if (c.isPunct('(')) c.skipParens();
          warnings.push(`${table.name}.${column.name}: 계산 컬럼의 식은 가져오지 않습니다`);
        }
      } else if (c.accept('AS')) {
        if (c.isPunct('(')) c.skipParens();
      } else if (c.accept('CHARACTER', 'SET') || c.accept('CHARSET') || c.accept('COLLATE')) {
        c.next();
      } else if (c.accept('ON', 'UPDATE')) {
        readExpression(c);
      } else if (c.accept('CONSTRAINT')) {
        if (!c.is('PRIMARY') && !c.is('UNIQUE') && !c.is('CHECK') && !c.is('REFERENCES') && !c.is('NOT')) c.next();
      } else if (c.accept('CHECK')) {
        if (c.isPunct('(')) c.skipParens();
      } else if (c.isPunct('(')) c.skipParens();
      else c.pos++;
    }
    if (column.primaryKey) column.nullable = false;
    table.columns.push(column);
  }

  /** 타입 읽기: 여러 단어 타입, 길이, UNSIGNED, 배열, SERIAL 처리 */
  function readType(c: Cursor, column: Column) {
    let type = c.next().value.toUpperCase();
    const two = (a: string, b: string) => type === a && c.is(b);
    if (two('DOUBLE', 'PRECISION') || two('CHARACTER', 'VARYING') || two('CHAR', 'VARYING') || two('BIT', 'VARYING')) {
      type += ' ' + c.next().value.toUpperCase();
    }
    if (c.isPunct('(')) column.length = c.skipParens().replace(/\s+/g, '');
    if ((type === 'TIMESTAMP' || type === 'TIME') && (c.is('WITH') || c.is('WITHOUT'))) {
      const withTz = c.next().value.toUpperCase() === 'WITH';
      c.accept('TIME', 'ZONE');
      if (withTz) type = type === 'TIMESTAMP' ? 'TIMESTAMPTZ' : 'TIMETZ';
    }
    if (type === 'CHARACTER VARYING' || type === 'CHAR VARYING') type = 'VARCHAR';
    if (type === 'CHARACTER') type = 'CHAR';
    if (SERIAL[type]) {
      type = SERIAL[type];
      column.autoIncrement = true;
    }
    const modifiers: string[] = [];
    while (c.is('UNSIGNED') || c.is('SIGNED') || c.is('ZEROFILL')) {
      const m = c.next().value.toUpperCase();
      if (m !== 'SIGNED') modifiers.push(m);
    }
    while (c.isPunct('[')) {
      c.pos++;
      if (c.isPunct(']')) c.pos++;
      type += '[]';
    }
    if (INTEGER_TYPES.has(type)) {
      // MySQL의 표시 폭 INT(11)은 의미가 없으므로 버린다. TINYINT(1)은 관례상 BOOLEAN.
      if (type === 'TINYINT' && column.length === '1' && !modifiers.length) type = 'BOOLEAN';
      column.length = '';
    }
    if (type === 'INTEGER') type = 'INT';
    column.type = [type, ...modifiers].join(' ');
  }

  /** DEFAULT 뒤의 식을 원문 그대로 읽는다. NULL이면 null. */
  function readExpression(c: Cursor): string | null {
    const first = c.peek();
    if (!first) return null;
    let last = first;
    if (c.isPunct('(')) {
      c.skipParens();
      last = c.peek(-1)!;
    } else if (c.isPunct('-') || c.isPunct('+')) {
      c.pos++;
      last = c.next();
    } else {
      last = c.next();
      if (c.isPunct('(')) { c.skipParens(); last = c.peek(-1)!; }
    }
    // PostgreSQL 형 변환: 'a'::character varying
    while (c.isPunct('::')) {
      c.pos++;
      last = c.next();
      while (c.peek()?.type === 'ident' && !STOP_WORDS.has(c.peek()!.value.toUpperCase())) last = c.next();
      if (c.isPunct('(')) { c.skipParens(); last = c.peek(-1)!; }
      if (c.isPunct('[')) { c.pos++; last = c.next(); }
    }
    if (first.type === 'string' && first === last) return `'${first.value.replace(/'/g, "''")}'`;
    const raw = c.raw(first, last);
    return /^null$/i.test(raw) ? null : raw;
  }

  function columnList(c: Cursor): string[] {
    c.expectPunct('(');
    const names: string[] = [];
    while (!c.isPunct(')')) {
      if (c.isPunct('(')) c.skipParens(); // 식 인덱스는 건너뛴다
      else names.push(c.identifier());
      // col(10), col DESC 등 나머지는 건너뛴다
      c.skipItem();
      if (!c.acceptPunct(',')) break;
    }
    c.expectPunct(')');
    return names;
  }

  /** USING btree / USING gin 등: 방식을 돌려준다 */
  function skipIndexType(c: Cursor): string {
    return c.accept('USING') ? c.next().value.toLowerCase() : '';
  }

  function parseReferences(c: Cursor): Omit<PendingForeignKey, 'name' | 'fromTable' | 'fromColumns'> {
    if (!c.accept('REFERENCES')) throw new Error('REFERENCES가 필요합니다');
    const toTable = c.qualifiedName();
    const toColumns = c.isPunct('(') ? columnList(c) : [];
    let onDelete: ReferentialAction = 'NO ACTION';
    let onUpdate: ReferentialAction = 'NO ACTION';
    while (!c.done && !c.isPunct(',') && !c.isPunct(')')) {
      if (c.accept('ON', 'DELETE')) onDelete = readAction(c);
      else if (c.accept('ON', 'UPDATE')) onUpdate = readAction(c);
      else if (c.accept('MATCH')) c.next();
      else if (c.accept('DEFERRABLE') || c.accept('NOT', 'DEFERRABLE') || c.accept('INITIALLY', 'DEFERRED') || c.accept('INITIALLY', 'IMMEDIATE')) { /* 무시 */ }
      else break;
    }
    return { toTable, toColumns, onDelete, onUpdate };
  }

  function readAction(c: Cursor): ReferentialAction {
    if (c.accept('CASCADE')) return 'CASCADE';
    if (c.accept('RESTRICT')) return 'RESTRICT';
    if (c.accept('SET', 'NULL')) return 'SET NULL';
    if (c.accept('SET', 'DEFAULT')) return 'SET DEFAULT';
    if (c.accept('NO', 'ACTION')) return 'NO ACTION';
    throw new Error(`알 수 없는 참조 동작: ${c.peek()?.value}`);
  }

  function addIndexByNames(table: Table, name: string, names: string[], unique: boolean) {
    const columnIds = names.map((n) => columnOf(table, n)?.id).filter((id): id is string => !!id);
    if (!columnIds.length) {
      warnings.push(`${table.name} 인덱스 ${name}: 컬럼을 찾지 못해 건너뜀`);
      return;
    }
    table.indexes.push(createIndex({ name, columnIds, unique }));
  }

  /**
   * ( ... ) 안이 컬럼 이름뿐이면 일반 인덱스, 식(함수·연산·연산자 클래스)이 있으면 원문 그대로 식 인덱스로 만든다.
   * 끝에 WHERE가 있으면 부분 인덱스 조건으로 담는다.
   */
  function addIndexFromList(c: Cursor, table: Table, name: string, unique: boolean, method: string) {
    const start = c.pos;
    const inner = c.skipParens();
    const plain = splitTopLevel(inner).every((part) => /^\s*[`"\[]?[\w$]+[`"\]]?(\s*\(\s*\d+\s*\))?(\s+(ASC|DESC))?\s*$/i.test(part));
    let where = '';
    if (c.accept('WHERE')) {
      const first = c.peek();
      let last = first;
      while (!c.done && !c.isPunct(',') && !c.isPunct(')')) {
        if (c.isPunct('(')) { c.skipParens(); last = c.peek(-1); }
        else last = c.next();
      }
      if (first && last) where = c.raw(first, last).trim();
    }
    const end = c.pos;
    const extra = { ...(method && method !== 'btree' ? { method } : {}), ...(where ? { where } : {}) };
    if (plain) {
      c.pos = start;
      const names = columnList(c);
      c.pos = end;
      if (!extra.method && !where) return addIndexByNames(table, name, names, unique);
      // 방식(gin 등)이나 조건이 있는 컬럼 인덱스: 컬럼으로 담되 방식·조건을 함께 기억한다
      const columnIds = names.map((n) => columnOf(table, n)?.id).filter((id): id is string => !!id);
      if (columnIds.length) table.indexes.push(createIndex({ name, columnIds, unique, ...extra }));
      return;
    }
    table.indexes.push(createIndex({ name, columnIds: [], unique, expression: inner, ...extra }));
  }

  function parseCreateIndex(c: Cursor, unique: boolean) {
    c.accept('CONCURRENTLY');
    c.accept('IF', 'NOT', 'EXISTS');
    const name = c.is('ON') ? '' : c.qualifiedName();
    let method = skipIndexType(c);
    if (!c.accept('ON')) throw new Error('ON이 필요합니다');
    c.accept('ONLY');
    const table = tableOf(c.qualifiedName());
    if (!table) throw new Error('인덱스의 테이블을 먼저 정의해야 합니다');
    method = skipIndexType(c) || method;
    addIndexFromList(c, table, name, unique, method);
  }

  function parseAlterTable(c: Cursor) {
    c.accept('ONLY');
    c.accept('IF', 'EXISTS');
    const tableName = c.qualifiedName();
    const table = tableOf(tableName);
    if (!table) throw new Error(`${tableName} 테이블을 먼저 정의해야 합니다`);
    while (!c.done) {
      if (c.accept('ADD')) {
        if (c.is('CONSTRAINT') || c.is('PRIMARY') || c.is('UNIQUE') || c.is('FOREIGN') || c.is('INDEX') || c.is('KEY') || c.is('CHECK')) {
          parseTableItem(c, table);
        } else {
          c.accept('COLUMN');
          c.accept('IF', 'NOT', 'EXISTS');
          parseColumn(c, table);
        }
      } else {
        c.skipItem();
      }
      if (!c.acceptPunct(',')) {
        c.skipItem();
        if (!c.acceptPunct(',')) break;
      }
    }
  }

  function parseCommentOn(c: Cursor) {
    if (c.accept('TABLE')) {
      const table = tableOf(c.qualifiedName());
      if (!c.accept('IS')) throw new Error('IS가 필요합니다');
      const value = c.next();
      if (table && value.type === 'string') setComment(table, value.value);
      return;
    }
    if (c.accept('COLUMN')) {
      const parts = [c.identifier()];
      while (c.acceptPunct('.')) parts.push(c.identifier());
      const columnName = parts.pop()!;
      const table = tableOf(parts.pop() ?? '');
      if (!c.accept('IS')) throw new Error('IS가 필요합니다');
      const value = c.next();
      const column = table && columnOf(table, columnName);
      if (column && value.type === 'string') setComment(column, value.value);
      return;
    }
    throw new Error('COMMENT ON TABLE/COLUMN만 지원합니다');
  }
}

/** 괄호·따옴표 밖의 콤마로 나눈다 */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = '';
  let current = '';
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
    } else if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
    } else if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}
