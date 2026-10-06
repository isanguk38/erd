/**
 * CREATE INDEX 정의에서 키 목록 ( ... ) 안쪽 원문을 꺼낸다.
 * 예) CREATE INDEX ix ON public.t USING gin (to_tsvector('simple'::regconfig, body)) WHERE (x > 0)
 *     → to_tsvector('simple'::regconfig, body)
 */
export function indexDefinitionKeys(definition: string | null | undefined): string | null {
  if (!definition) return null;
  const on = definition.search(/\sON\s/i);
  if (on < 0) return null;
  const open = definition.indexOf('(', on);
  if (open < 0) return null;
  let depth = 0;
  let quote = '';
  for (let i = open; i < definition.length; i++) {
    const ch = definition[i];
    if (quote) {
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return definition.slice(open + 1, i).trim();
  }
  return null;
}

/** 키 목록이 컬럼 이름만으로 되어 있는지 (DESC·NULLS FIRST 같은 정렬이 있으면 원문으로 담는다) */
export function isPlainKeyList(keys: string): boolean {
  return splitTopLevel(keys).every((part) => /^\s*[`"[]?[\w$]+[`"\]]?(\s+ASC)?\s*$/i.test(part));
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
