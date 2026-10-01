export type TokenType = 'ident' | 'quoted' | 'string' | 'number' | 'punct' | 'op';

export interface Token {
  type: TokenType;
  /** 식별자는 따옴표를 벗긴 값, 문자열은 이스케이프를 푼 값 */
  value: string;
  /** 원문 위치 (기본값 식을 원문 그대로 가져올 때 쓴다) */
  start: number;
  end: number;
}

const PUNCT = new Set(['(', ')', ',', ';', '.', '=']);

/**
 * MySQL / PostgreSQL DDL을 읽기 위한 토크나이저. 주석은 건너뛴다.
 * backslashEscapes: MySQL은 '...' 안의 \ 를 이스케이프로 본다. PostgreSQL은 E'...'에서만.
 */
export function tokenize(sql: string, backslashEscapes = true): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const ch = sql[i];

    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '-' && sql[i + 1] === '-') { while (i < n && sql[i] !== '\n') i++; continue; }
    if (ch === '#') { while (i < n && sql[i] !== '\n') i++; continue; }
    if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }

    const start = i;
    if (ch === "'" || (ch.toUpperCase() === 'E' && sql[i + 1] === "'")) {
      const escapes = backslashEscapes || ch !== "'";
      if (ch !== "'") i++;
      i++;
      let value = '';
      while (i < n) {
        const c = sql[i];
        if (escapes && c === '\\' && i + 1 < n) { value += unescape(sql[i + 1]); i += 2; continue; }
        if (c === "'") {
          if (sql[i + 1] === "'") { value += "'"; i += 2; continue; }
          i++;
          break;
        }
        value += c;
        i++;
      }
      tokens.push({ type: 'string', value, start, end: i });
      continue;
    }
    if (ch === '`' || ch === '"') {
      i++;
      let value = '';
      while (i < n) {
        if (sql[i] === ch) {
          if (sql[i + 1] === ch) { value += ch; i += 2; continue; }
          i++;
          break;
        }
        value += sql[i++];
      }
      tokens.push({ type: 'quoted', value, start, end: i });
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(sql[i + 1] ?? ''))) {
      while (i < n && /[0-9.eE]/.test(sql[i])) i++;
      tokens.push({ type: 'number', value: sql.slice(start, i), start, end: i });
      continue;
    }
    if (/[A-Za-z_\u0080-￿$]/.test(ch)) {
      while (i < n && /[A-Za-z0-9_\u0080-￿$]/.test(sql[i])) i++;
      tokens.push({ type: 'ident', value: sql.slice(start, i), start, end: i });
      continue;
    }
    if (PUNCT.has(ch)) {
      tokens.push({ type: 'punct', value: ch, start, end: i + 1 });
      i++;
      continue;
    }
    // ::, [], +, - 등 나머지 연산자
    if (ch === ':' && sql[i + 1] === ':') {
      tokens.push({ type: 'op', value: '::', start, end: i + 2 });
      i += 2;
      continue;
    }
    tokens.push({ type: 'op', value: ch, start, end: i + 1 });
    i++;
  }
  return tokens;
}

function unescape(c: string): string {
  if (c === 'n') return '\n';
  if (c === 't') return '\t';
  if (c === 'r') return '\r';
  if (c === '0') return '\0';
  return c;
}

/** 문장 단위로 나눈다 (세미콜론 기준) */
export function splitStatements(tokens: Token[]): Token[][] {
  const statements: Token[][] = [];
  let current: Token[] = [];
  for (const t of tokens) {
    if (t.type === 'punct' && t.value === ';') {
      if (current.length) statements.push(current);
      current = [];
    } else current.push(t);
  }
  if (current.length) statements.push(current);
  return statements;
}
