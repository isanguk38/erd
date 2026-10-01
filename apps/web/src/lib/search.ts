import type { Schema } from '@erd/core';

export interface SearchResult {
  kind: 'table' | 'column';
  tableId: string;
  columnId?: string;
  /** 보여줄 이름 (테이블 또는 테이블.컬럼) */
  title: string;
  /** 논리명·타입 등 보조 정보 */
  detail: string;
  /** 어디서 찾았는지 */
  matchedIn: '물리명' | '논리명' | '설명' | '타입';
  score: number;
}

/** 정확히 같음 > 앞부분 같음 > 단어 시작 > 포함 순으로 점수를 준다 (대소문자·공백 무시) */
function scoreOf(text: string | undefined, q: string): number {
  if (!text) return 0;
  const t = text.toLowerCase();
  if (t === q) return 100;
  if (t.startsWith(q)) return 80;
  if (t.split(/[_\s.]+/).some((w) => w.startsWith(q))) return 60;
  if (t.includes(q)) return 40;
  return 0;
}

/** 테이블·컬럼의 물리명/논리명/설명/타입에서 찾는다 */
export function searchSchema(schema: Schema, query: string, limit = 50): SearchResult[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const results: SearchResult[] = [];
  for (const t of schema.tables) {
    const fields: [SearchResult['matchedIn'], string | undefined, number][] = [
      ['물리명', t.name, 1.2],
      ['논리명', t.logicalName, 1.2],
      ['설명', t.comment, 0.6],
    ];
    let best = 0;
    let matchedIn: SearchResult['matchedIn'] = '물리명';
    for (const [where, text, weight] of fields) {
      const sc = scoreOf(text, q) * weight;
      if (sc > best) {
        best = sc;
        matchedIn = where;
      }
    }
    if (best > 0) results.push({ kind: 'table', tableId: t.id, title: t.name, detail: [t.logicalName, `컬럼 ${t.columns.length}개`].filter(Boolean).join(' · '), matchedIn, score: best });

    for (const c of t.columns) {
      const colFields: [SearchResult['matchedIn'], string | undefined, number][] = [
        ['물리명', c.name, 1],
        ['논리명', c.logicalName, 1],
        ['설명', c.comment, 0.5],
        ['타입', c.type, 0.3],
      ];
      let cBest = 0;
      let cWhere: SearchResult['matchedIn'] = '물리명';
      for (const [where, text, weight] of colFields) {
        const sc = scoreOf(text, q) * weight;
        if (sc > cBest) {
          cBest = sc;
          cWhere = where;
        }
      }
      if (cBest > 0) {
        const type = c.length ? `${c.type}(${c.length})` : c.type;
        results.push({
          kind: 'column',
          tableId: t.id,
          columnId: c.id,
          title: `${t.name}.${c.name}`,
          detail: [c.logicalName, type, c.primaryKey ? 'PK' : ''].filter(Boolean).join(' · '),
          matchedIn: cWhere,
          score: cBest,
        });
      }
    }
  }
  return results.sort((a, b) => b.score - a.score || (a.kind === 'table' ? -1 : 1) || a.title.localeCompare(b.title)).slice(0, limit);
}

/** 캔버스 강조용: 검색어에 걸리는 테이블과 컬럼 id */
export function matchIds(schema: Schema, query: string): { tables: Set<string>; columns: Set<string> } {
  const tables = new Set<string>();
  const columns = new Set<string>();
  for (const r of searchSchema(schema, query, 10_000)) {
    tables.add(r.tableId);
    if (r.columnId) columns.add(r.columnId);
  }
  return { tables, columns };
}
