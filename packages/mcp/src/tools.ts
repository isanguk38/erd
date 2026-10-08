// ERD MCP 도구. AI가 ERD를 읽고, 고치고, SQL·정의서를 만들고, DB와 동기화한다.
// 모든 동작은 ERD 서버 API를 거치므로 화면을 보고 있는 사람에게 변경이 실시간으로 보인다.

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { areaSchema, describeMatch, describeSchema, dialects, dictIndex, lookupTerm, requireArea, LINT_RULES, lintSchema, reviewItemState, searchDictionary, splitDictType, unreviewedTables, type AiReview, type DialectId, type Dictionary, type Schema } from '@erd/core';

/** ERD 서버 호출 방법 (HTTP 또는 서버 안에서 직접) */
export interface ErdApi {
  request<T = unknown>(method: string, path: string, body?: unknown): Promise<T>;
  download(path: string): Promise<ArrayBuffer>;
  /** 화면에서 열 수 있는 주소 (안내용) */
  webUrl?: string;
}

export interface ToolOptions {
  /** 정의서를 로컬 파일로 저장할 수 있는지 (stdio 실행일 때) */
  canWriteFiles: boolean;
}

interface ProjectInfo { id: string; name: string; dialect: string; tableCount: number; updatedAt: string }

const referentialAction = z.enum(['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT']);

const columnSpec = z.object({
  name: z.string().describe('물리명 (예: member_id)'),
  logicalName: z.string().optional().describe('논리명 (예: 회원번호)'),
  type: z.string().optional().describe('타입. 길이를 붙여도 된다 (예: VARCHAR(100), DECIMAL(12,2), BIGINT)'),
  nullable: z.boolean().optional().describe('NULL 허용 (기본 true)'),
  primaryKey: z.boolean().optional(),
  unique: z.boolean().optional(),
  autoIncrement: z.boolean().optional(),
  default: z.string().nullable().optional().describe("SQL 식 그대로. 문자열은 따옴표 포함 (예: 'Y', 0, CURRENT_TIMESTAMP)"),
  onUpdate: z.string().nullable().optional().describe('MySQL·MariaDB 전용: 행이 바뀔 때 넣는 값 (예: CURRENT_TIMESTAMP). null이면 해제'),
  generated: z.string().nullable().optional().describe('계산 컬럼 식 (예: qty * price). null이면 일반 컬럼으로'),
  generatedStored: z.boolean().optional().describe('계산 값을 저장(STORED)할지. 기본 VIRTUAL (PostgreSQL은 STORED만, Oracle은 VIRTUAL만)'),
  comment: z.string().optional(),
});

const command = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('createTable'),
    name: z.string(),
    logicalName: z.string().optional(),
    comment: z.string().optional(),
    columns: z.array(columnSpec).optional(),
    area: z.string().optional().describe('넣을 주제영역 이름 (그 영역 탭에 함께 놓인다)'),
  }),
  z.object({ op: z.literal('updateTable'), table: z.string(), name: z.string().optional(), logicalName: z.string().optional(), comment: z.string().optional() }),
  z.object({ op: z.literal('dropTable'), table: z.string() }),
  z.object({ op: z.literal('addColumn'), table: z.string(), column: columnSpec, after: z.string().optional().describe('이 컬럼 뒤에 추가') }),
  z.object({ op: z.literal('updateColumn'), table: z.string(), column: z.string(), changes: columnSpec.partial() }),
  z.object({ op: z.literal('dropColumn'), table: z.string(), column: z.string() }),
  z.object({
    op: z.literal('addIndex'),
    table: z.string(),
    columns: z.array(z.string()).min(1).optional().describe('인덱스 컬럼. 식 인덱스면 비우고 expression을 쓴다'),
    expression: z
      .string()
      .optional()
      .describe("식(함수) 인덱스: ON 테이블 ( ... ) 괄호 안 원문. 예) PostgreSQL: lower(email), (metadata ->> 'sitecd') / MySQL 8: (lower(`email`))"),
    method: z.string().optional().describe('PostgreSQL 인덱스 방식: gin, gist, brin, hash (비우면 btree)'),
    where: z.string().optional().describe('부분 인덱스 조건 (WHERE 뒤 식)'),
    unique: z.boolean().optional(),
    name: z.string().optional(),
  }),
  z.object({ op: z.literal('dropIndex'), table: z.string(), name: z.string().optional(), columns: z.array(z.string()).optional() }),
  z.object({
    op: z.literal('addCheck'),
    table: z.string(),
    expression: z.string().describe('CHECK ( ... ) 괄호 안 조건. 예: point >= 0'),
    name: z.string().optional().describe('제약 이름 (비우면 ck_테이블_번호)'),
  }),
  z.object({ op: z.literal('dropCheck'), table: z.string(), name: z.string().optional(), expression: z.string().optional().describe('이름 대신 조건으로 찾기') }),
  z.object({
    op: z.literal('addRelation'),
    parent: z.string().describe('참조되는(부모) 테이블. 이 테이블의 기본키를 자식이 FK로 가진다'),
    child: z.string().describe('FK를 가질(자식) 테이블. FK 컬럼은 자동으로 만들어진다'),
    cardinality: z.enum(['1:1', '1:N', 'N:M']).optional().describe('N:M이면 연결 테이블을 자동으로 만든다'),
    identifying: z.boolean().optional().describe('식별 관계: FK가 자식의 기본키에 포함된다'),
    onDelete: referentialAction.optional(),
    onUpdate: referentialAction.optional(),
  }),
  z.object({ op: z.literal('dropRelation'), parent: z.string(), child: z.string(), dropColumns: z.boolean().optional() }),
  // 주제영역: 큰 ERD를 기능별로 나눠 보는 탭 (화면 구분일 뿐 SQL·DB에는 영향 없음). 같은 테이블을 여러 영역에 넣을 수 있다
  z.object({ op: z.literal('createArea'), name: z.string().describe('영역 이름 (예: 주문, 회원, 정산)'), tables: z.array(z.string()).optional().describe('처음 넣을 테이블') }),
  z.object({ op: z.literal('updateArea'), area: z.string(), name: z.string().optional().describe('새 이름') }),
  z.object({ op: z.literal('dropArea'), area: z.string().describe('지울 영역 (테이블은 남는다)') }),
  z.object({ op: z.literal('addToArea'), area: z.string(), tables: z.array(z.string()).min(1).describe('넣을 테이블 (다른 영역에도 그대로 남는다)') }),
  z.object({ op: z.literal('removeFromArea'), area: z.string(), tables: z.array(z.string()).min(1).describe('영역에서 뺄 테이블 (테이블은 남는다)') }),
  z.object({
    op: z.literal('moveToArea'),
    area: z.string().describe('옮겨 갈 영역'),
    tables: z.array(z.string()).min(1),
    from: z.string().optional().describe('이 영역에서만 뺀다. 생략하면 다른 모든 영역에서 빼고 이 영역에만 둔다'),
  }),
]);

const mode = z.enum(['apply', 'propose']).optional().describe('apply: 바로 반영(되돌리기 가능), propose: 제안으로 모아 사람이 승인. 생략하면 프로젝트 설정을 따른다');
const projectArg = z.string().describe('프로젝트 id 또는 이름');
const dialectArg = z.enum(Object.keys(dialects) as [DialectId, ...DialectId[]]).describe('DB 종류: mysql, mariadb, postgresql, oracle, mssql');

const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });

function safe<A>(fn: (args: A) => Promise<ReturnType<typeof text>>) {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (e) {
      return { content: [{ type: 'text' as const, text: `오류: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
    }
  };
}

export function registerErdTools(server: McpServer, api: ErdApi, options: ToolOptions): void {
  /** 설계를 바꾼 뒤 아직 AI 검토하지 않은 테이블을 알려 준다 (AI가 작업을 마칠 때 검토하게) */
  async function reviewReminder(projectId: string): Promise<string | undefined> {
    try {
      const { meta, schema } = await api.request<{ meta: Record<string, unknown>; schema: Schema }>('GET', `/api/projects/${projectId}`);
      return reviewNeeded(schema, (meta.aiReview as AiReview | null | undefined) ?? null);
    } catch {
      return undefined;
    }
  }

  const resolveProject = async (ref: string): Promise<ProjectInfo> => {
    const list = await api.request<ProjectInfo[]>('GET', '/api/projects');
    const found = list.find((p) => p.id === ref) ?? list.find((p) => p.name.toLowerCase() === ref.toLowerCase());
    if (!found) throw new Error(`프로젝트 "${ref}"가 없습니다. 있는 프로젝트: ${list.map((p) => p.name).join(', ') || '(없음)'}`);
    return found;
  };
  const resolveConnection = async (ref: string) => {
    const list = await api.request<{ id: string; name: string; dialect: string; database: string }[]>('GET', '/api/connections');
    const found = list.find((c) => c.id === ref) ?? list.find((c) => c.name.toLowerCase() === ref.toLowerCase());
    if (!found) throw new Error(`DB 연결 "${ref}"이 없습니다. 있는 연결: ${list.map((c) => c.name).join(', ') || '(없음 — 화면에서 먼저 연결을 추가하세요)'}`);
    return found;
  };
  const link = (id: string) => (api.webUrl ? `${api.webUrl}/#/p/${id}` : undefined);
  /** 프로젝트의 표준 용어 사전 (없으면 null) */
  const dictionaryOf = async (projectId: string): Promise<Dictionary | null> => {
    try {
      return (await api.request<{ dictionary: Dictionary | null }>('GET', `/api/projects/${projectId}/dictionary`)).dictionary;
    } catch {
      return null;
    }
  };
  const dictionaryHint = (d: Dictionary | null) =>
    d ? `표준 용어 사전 있음 (용어 ${d.terms.length}개): 컬럼을 만들거나 이름을 바꿀 때 lookup_dictionary로 논리명의 표준 물리명·타입·길이를 찾아 그대로 쓰세요` : undefined;

  server.registerTool(
    'list_projects',
    { title: 'ERD 프로젝트 목록', description: 'ERD 프로젝트 목록을 보여준다.', inputSchema: {}, annotations: { readOnlyHint: true } },
    safe(async () => text(await api.request('GET', '/api/projects'))),
  );

  server.registerTool(
    'create_project',
    {
      title: 'ERD 프로젝트 만들기',
      description: '빈 ERD 프로젝트를 만든다.',
      inputSchema: { name: z.string(), dialect: dialectArg.optional() },
    },
    safe(async ({ name, dialect }: { name: string; dialect?: string }) => {
      const p = await api.request<ProjectInfo>('POST', '/api/projects', { name, dialect: dialect ?? 'mysql' });
      return text({ ...p, url: link(p.id) });
    }),
  );

  server.registerTool(
    'get_schema',
    {
      title: 'ERD 스키마 읽기',
      description: [
        '프로젝트의 테이블·컬럼·인덱스·관계·주제영역을 읽는다. 편집하기 전에 먼저 호출해 지금 구조를 확인한다.',
        'area를 주면 그 영역의 테이블만 읽고, 영역 밖 테이블과의 관계는 outsideRelations로 알려 준다 (큰 ERD를 영역 단위로 볼 때).',
      ].join(' '),
      inputSchema: { project: projectArg, area: z.string().optional().describe('주제영역 이름 (생략하면 전체)') },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ project, area }: { project: string; area?: string }) => {
      const p = await resolveProject(project);
      const { meta, schema } = await api.request<{ meta: Record<string, unknown>; schema: Schema }>('GET', `/api/projects/${p.id}`);
      const info = { id: p.id, name: meta.name, dialect: meta.dialect, aiMode: meta.aiMode, url: link(p.id), dictionary: dictionaryHint(await dictionaryOf(p.id)) };
      if (!area) return text({ project: info, ...describeSchema(schema) });
      const part = areaSchema(schema, area);
      const { areas: _all, ...described } = describeSchema(part.schema);
      return text({
        project: info,
        area: requireArea(schema, area).name,
        ...described,
        outsideRelations: part.outside.length ? part.outside.map((o) => `${o.table} ↔ ${o.outsideTable} (영역 밖)`) : undefined,
        otherAreas: (schema.areas ?? []).filter((a) => a.name !== requireArea(schema, area).name).map((a) => a.name),
      });
    }),
  );

  server.registerTool(
    'check_design',
    {
      title: '설계 검사',
      description: [
        '설계 검사 목록을 읽는다: ① 기본 검사(ERD가 코드로 찾는 확실한 문제: 기본키 없음, DB에서 실패하는 타입, FK 타입 불일치 등)',
        '② 지난 AI 검토에서 남은 항목(save_design_review로 저장한 것, id 포함). 사람이 "무시"한 항목은 빠진다 — 무시한 항목은 고치지 않는다.',
        '"다시 확인 필요"(stale)는 검토 뒤 사람이 그 테이블을 고친 것이라 지금도 문제인지 다시 본다.',
        '고칠 때는 edit_schema를 쓰고, AI 검토 항목을 고쳤으면 resolve_design_review로 해결 표시한다.',
        'area를 주면 그 주제영역 테이블에 대한 항목만 본다 (영역 단위 검토: save_design_review의 tables에 areaTables를 넣는다).',
      ].join(' '),
      inputSchema: { project: projectArg, area: z.string().optional().describe('주제영역 이름 (생략하면 전체)') },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ project, area }: { project: string; area?: string }) => {
      const p = await resolveProject(project);
      const { meta, schema } = await api.request<{ meta: Record<string, unknown>; schema: Schema }>('GET', `/api/projects/${p.id}`);
      // 사람이 화면에서 "무시"한 항목은 빼고 알려준다
      const ignored = new Set(Array.isArray(meta.lintIgnored) ? (meta.lintIgnored as string[]) : []);
      // 영역을 주면 그 영역 테이블에 대한 것만
      const scope = area ? requireArea(schema, area) : null;
      const scopeNames = scope ? new Set(scope.tableIds.map((id) => schema.tables.find((t) => t.id === id)?.name.toLowerCase())) : null;
      const inScope = (table?: string) => !scopeNames || (table ? scopeNames.has(table.toLowerCase()) : false);
      const all = lintSchema(schema, String(meta.dialect ?? 'mysql'), { dictionary: await dictionaryOf(p.id) }).filter((i) => inScope(i.tableName));
      const issues = all.filter((i) => !ignored.has(i.id));
      const review = (meta.aiReview as AiReview | null | undefined) ?? null;
      const reviewOpen = (review?.items ?? []).filter((i) => i.status === 'open' && (!scope || inScope(i.table)));
      const reviewItems = reviewOpen.filter((i) => !ignored.has(i.id)).map((i) => ({ ...i, state: reviewItemState(i, schema) })).filter((i) => i.state !== 'missing');
      const skipped = all.length - issues.length + (reviewOpen.length - reviewOpen.filter((i) => !ignored.has(i.id)).length);
      const counts = { error: 0, warning: 0, info: 0 };
      for (const i of [...issues, ...reviewItems]) counts[i.severity]++;
      return text({
        summary: `${scope ? `영역 ${scope.name}: ` : ''}오류 ${counts.error} · 경고 ${counts.warning} · 참고 ${counts.info}${skipped ? ` (사람이 무시한 항목 ${skipped}개 제외 — 고치지 말 것)` : ''}`,
        areaTables: scope ? scope.tableIds.map((id) => schema.tables.find((t) => t.id === id)?.name).filter(Boolean) : undefined,
        reviewNeeded: reviewNeeded(schema, review),
        basicChecks: issues.map((i) => ({ severity: i.severity, rule: LINT_RULES[i.rule].label, table: i.tableName, column: i.columnName, message: i.message })),
        aiReview: review
          ? {
              reviewedAt: review.reviewedAt,
              items: reviewItems.map((i) => ({ id: i.id, severity: i.severity, table: i.table || undefined, column: i.column, message: i.message, suggestion: i.suggestion, state: i.state === 'stale' ? '다시 확인 필요' : '열림' })),
            }
          : '아직 AI 검토가 없습니다. 설계를 검토해 save_design_review로 저장하세요.',
      });
    }),
  );

  server.registerTool(
    'save_design_review',
    {
      title: 'AI 설계 검토 저장',
      description: [
        '내가(AI) 설계를 검토해 찾은 문제를 설계 검사 목록에 저장한다. 사람은 화면의 설계 검사 패널에서 보고, 동의하지 않으면 "무시"한다.',
        'severity: error(이대로면 DB에서 실패하거나 데이터가 깨짐) / warning(실무에서 문제가 될 가능성이 큼) / info(개선 제안).',
        '기본 검사(check_design의 basicChecks)와 같은 내용은 다시 넣지 않는다.',
        '이번에 찾은 항목을 더한다 — 이전에 열린 항목은 이번에 안 넣어도 그대로 남는다. 고쳤거나 더 이상 해당 없는 항목은 resolve_design_review로 이유와 함께 해결 표시해야 닫힌다.',
        'tables(검토 범위): 이번에 검토한 테이블 이름 (그 테이블만 "검토함"으로 기록). 기능을 추가했으면 새로 만들거나 고친 테이블과 그 관계 상대만 검토해 넣는다. 생략하면 ERD 전체를 검토한 것으로 본다.',
        '같은 내용은 같은 id가 되어 사람이 무시한 기록이 이어진다. 언제: 설계 작업(edit_schema 여러 번)을 마쳤을 때 한 번, 또는 사용자가 검토를 요청할 때. 명령마다 하지 않는다.',
      ].join(' '),
      inputSchema: {
        project: projectArg,
        items: z
          .array(
            z.object({
              severity: z.enum(['error', 'warning', 'info']),
              table: z.string().optional().describe('대상 테이블 물리명 (프로젝트 전체에 대한 것이면 생략)'),
              column: z.string().optional(),
              message: z.string().describe('무엇이 문제인지 (한국어, 한 문장)'),
              suggestion: z.string().optional().describe('어떻게 고치면 되는지'),
            }),
          )
          .describe('검토 결과 전체 (문제가 없으면 빈 배열)'),
        summary: z.string().optional().describe('검토 요약 한두 문장'),
        tables: z.array(z.string()).optional().describe('검토 범위: 이번에 검토한 테이블 이름 (생략하면 ERD 전체)'),
      },
    },
    safe(async ({ project, items, summary, tables }: { project: string; items: unknown[]; summary?: string; tables?: string[] }) => {
      const p = await resolveProject(project);
      const r = await api.request<{ saved: number; ignored: string[]; items: { id: string; severity: string; table: string; message: string }[]; stillUnreviewed: string[] }>(
        'PUT',
        `/api/projects/${p.id}/ai-review`,
        { items, summary, by: 'AI', scope: tables },
      );
      return text({
        saved: r.saved,
        stillUnreviewed: r.stillUnreviewed.length ? `아직 검토하지 않은 바뀐 테이블: ${r.stillUnreviewed.join(', ')}` : undefined,
        alreadyIgnoredByHuman: r.ignored.length ? `${r.ignored.length}개는 사람이 전에 무시한 항목이라 화면에 보이지 않고 고치지도 않는다` : undefined,
        items: r.items.map((i) => ({ id: i.id, severity: i.severity, table: i.table || undefined, message: i.message })),
      });
    }),
  );

  server.registerTool(
    'resolve_design_review',
    {
      title: 'AI 검토 항목 해결 표시',
      description: [
        'AI 검토 항목(check_design의 aiReview id)을 해결됨으로 표시한다. edit_schema로 고쳤거나, 다시 보니 더 이상 해당 없을 때 쓴다. resolution에 무엇을 어떻게 고쳤는지(또는 왜 해당 없는지) 적는다. 못 고친 항목은 해결 표시하지 않는다.',
        '고친 뒤 사용자에게 오류·경고·참고별로 무엇을 고쳤고 무엇을 남겼는지(무시된 것 포함) 알려 준다.',
      ].join(' '),
      inputSchema: { project: projectArg, ids: z.array(z.string()).min(1), resolution: z.string().optional() },
    },
    safe(async ({ project, ids, resolution }: { project: string; ids: string[]; resolution?: string }) => {
      const p = await resolveProject(project);
      return text(await api.request('POST', `/api/projects/${p.id}/ai-review/resolve`, { ids, resolution }));
    }),
  );

  server.registerTool(
    'edit_schema',
    {
      title: 'ERD 편집',
      description: [
        'ERD를 고친다. 여러 명령을 한 번에 보내면 전부 성공하거나 전부 실패한다.',
        '테이블·컬럼은 이름(물리명 또는 논리명)으로 가리킨다.',
        '관계(addRelation)는 부모의 기본키를 참조하는 FK 컬럼을 자식에 자동으로 만든다. FK 컬럼을 따로 addColumn 하지 않는다.',
        'mode=apply면 화면에 바로 반영되고 사람이 "AI 변경 되돌리기"로 한 번에 되돌릴 수 있다. mode=propose면 제안으로 쌓여 사람이 승인한다.',
        '결과의 impact: 지운 테이블·컬럼 때문에 함께 사라진 외래키·인덱스, 타입을 바꿨는데 FK로 이어진 컬럼은 그대로인 것 — 의도와 다르면 이어서 고친다.',
        '결과의 dictionary: 표준 용어 사전과 다른 컬럼 — 표준대로 updateColumn 한다 (사전에 없는 용어는 사용자에게 알린다).',
      ].join(' '),
      inputSchema: { project: projectArg, commands: z.array(command).min(1), mode },
    },
    safe(async ({ project, commands, mode: m }: { project: string; commands: unknown[]; mode?: string }) => {
      const p = await resolveProject(project);
      const result = await api.request<Record<string, unknown>>('POST', `/api/projects/${p.id}/commands`, { commands, mode: m, source: 'ai', title: 'AI 제안' });
      // 영역(화면 구분)만 바꿨으면 설계가 바뀐 게 아니라 검토 안내를 붙이지 않는다
      const areaOnly = commands.every((c) => /Area$/.test(String((c as { op?: string }).op)));
      return text(areaOnly ? result : { ...result, designReview: await reviewReminder(p.id) });
    }),
  );

  server.registerTool(
    'lookup_dictionary',
    {
      title: '표준 용어 사전 찾기',
      description: [
        '프로젝트의 표준 용어 사전(사람이 엑셀로 올린 것)에서 논리명의 표준 물리명·타입·길이를 찾는다.',
        'names에 만들 컬럼의 논리명들(예: ["회원번호","주문금액"])을 주면 각각의 표준 물리명·타입을 알려 준다 (프로젝트의 물리명 표기 적용). 사전에 없으면 null.',
        'query로 사전을 검색할 수도 있다 (비슷한 용어 찾기). 사전이 없으면 사전 없이 평소대로 설계한다.',
      ].join(' '),
      inputSchema: {
        project: projectArg,
        names: z.array(z.string()).optional().describe('찾을 논리명들'),
        query: z.string().optional().describe('사전 검색어 (논리명·물리명·설명에 들어 있는 것)'),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ project, names, query }: { project: string; names?: string[]; query?: string }) => {
      const p = await resolveProject(project);
      const dict = await dictionaryOf(p.id);
      if (!dict) return text('이 프로젝트에는 표준 용어 사전이 없습니다. 사전 없이 평소대로 설계하세요 (사람이 화면의 "용어 사전"에서 엑셀로 올릴 수 있음).');
      const index = dictIndex(dict);
      const typeText = (type?: string, length?: string) => {
        const st = splitDictType(type, length);
        return st.type ? `${st.type}${st.length ? `(${st.length})` : ''}` : undefined;
      };
      const term = (t: { logical: string; physical: string; type?: string; length?: string; description?: string }) => ({ logicalName: t.logical, name: t.physical, type: typeText(t.type, t.length), description: t.description });
      return text({
        dictionary: `용어 ${dict.terms.length}개, 물리명 표기: ${{ asis: '사전 그대로', lower: 'snake_case', upper: 'SNAKE_CASE', camel: 'camelCase' }[dict.case]}`,
        results: names?.length
          ? names.map((n) => {
              const m = lookupTerm(index, n);
              if (!m) return { logicalName: n, standard: null, note: '사전에 없음 — query로 비슷한 용어를 찾거나 사용자에게 확인' };
              return {
                logicalName: n,
                name: m.physical,
                type: typeText(m.type, m.length),
                summary: describeMatch(m),
              };
            })
          : undefined,
        matches: query?.trim()
          ? searchDictionary(dict.terms, query, 50).map(term)
          : undefined,
        sample: !names?.length && !query?.trim() ? dict.terms.slice(0, 30).map(term) : undefined,
      });
    }),
  );

  server.registerTool(
    'edit_notes',
    {
      title: '캔버스 메모',
      description: [
        'ERD 캔버스에 붙이는 메모(포스트잇)를 읽고 쓴다. 설계 의도·규칙·주의 사항을 사람이 보게 남길 때 쓴다 (예: "결제는 PG사 기준, 환불은 별도 테이블").',
        '메모는 SQL·DB에는 영향이 없다. area를 주면 그 주제영역 탭에, 없으면 전체 탭에 붙는다. 위치를 안 주면 그 탭 테이블들 오른쪽에 놓는다.',
        'action: list(목록) / add(text 필수) / update(id, 바꿀 값) / delete(id). 사용자가 요청할 때만 메모를 만든다.',
      ].join(' '),
      inputSchema: {
        project: projectArg,
        action: z.enum(['list', 'add', 'update', 'delete']),
        id: z.string().optional().describe('update·delete할 메모 id (list로 확인)'),
        text: z.string().optional().describe('메모 내용 (여러 줄 가능)'),
        area: z.string().optional().describe('붙일 주제영역 이름 (add, 생략하면 전체 탭)'),
        color: z.enum(['yellow', 'blue', 'green', 'pink', 'purple', 'gray']).optional(),
        x: z.number().optional(),
        y: z.number().optional(),
        width: z.number().optional(),
        height: z.number().optional(),
      },
    },
    safe(async (args: { project: string; action: 'list' | 'add' | 'update' | 'delete'; id?: string; text?: string; area?: string; color?: string; x?: number; y?: number; width?: number; height?: number }) => {
      const p = await resolveProject(args.project);
      const COLORS: Record<string, string> = { yellow: '#fef3c7', blue: '#dbeafe', green: '#dcfce7', pink: '#fce7f3', purple: '#ede9fe', gray: '#f1f5f9' };
      const body = { text: args.text, area: args.area, color: args.color ? COLORS[args.color] : undefined, x: args.x, y: args.y, width: args.width, height: args.height, source: 'ai' };
      if (args.action === 'list') return text(await api.request('GET', `/api/projects/${p.id}/notes`));
      if (args.action === 'add') return text(await api.request('POST', `/api/projects/${p.id}/notes`, body));
      if (!args.id) throw new Error('id가 필요합니다 (list로 확인)');
      if (args.action === 'update') return text(await api.request('PATCH', `/api/projects/${p.id}/notes/${encodeURIComponent(args.id)}`, body));
      return text(await api.request('DELETE', `/api/projects/${p.id}/notes/${encodeURIComponent(args.id)}`));
    }),
  );

  server.registerTool(
    'import_ddl',
    {
      title: 'DDL로 ERD 갱신',
      description: 'CREATE TABLE 등 DDL을 읽어 ERD에 합친다. 같은 이름의 테이블은 갱신하고, DDL에 없는 테이블은 지우지 않는다.',
      inputSchema: { project: projectArg, sql: z.string(), dialect: z.enum(['auto', 'mysql', 'postgresql']).optional(), mode },
    },
    safe(async ({ project, sql, dialect, mode: m }: { project: string; sql: string; dialect?: string; mode?: string }) => {
      const p = await resolveProject(project);
      const result = await api.request<Record<string, unknown>>('POST', `/api/projects/${p.id}/import-ddl`, { sql, dialect, mode: m, source: 'ai' });
      return text({ ...result, designReview: await reviewReminder(p.id) });
    }),
  );

  server.registerTool(
    'export_sql',
    {
      title: 'SQL 만들기',
      description: 'ERD로 SQL을 만든다. since_version을 주면 그 버전 이후 바뀐 부분만 ALTER/CREATE로 만든다 (CREATE/ALTER/DROP 구분 포함).',
      inputSchema: { project: projectArg, dialect: dialectArg.optional(), since_version: z.string().optional().describe('버전 id (list_versions로 확인)') },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ project, dialect, since_version }: { project: string; dialect?: string; since_version?: string }) => {
      const p = await resolveProject(project);
      const q = new URLSearchParams();
      if (dialect) q.set('dialect', dialect);
      if (since_version) q.set('since', since_version);
      const r = await api.request<{ script: string; changes: unknown[] }>('GET', `/api/projects/${p.id}/sql?${q}`);
      return text(r.script || '-- 변경 없음');
    }),
  );

  server.registerTool(
    'auto_layout',
    {
      title: '자동 배치',
      description: '관계를 보고 테이블 위치를 자동으로 정리한다. area를 주면 그 주제영역 탭의 배치만 정리한다 (영역을 새로 묶은 뒤 영역마다 한 번씩).',
      inputSchema: { project: projectArg, area: z.string().optional().describe('주제영역 이름 (생략하면 전체 ERD)') },
    },
    safe(async ({ project, area }: { project: string; area?: string }) => {
      const p = await resolveProject(project);
      return text(await api.request('POST', `/api/projects/${p.id}/layout`, area ? { area } : undefined));
    }),
  );

  server.registerTool(
    'save_version',
    { title: '버전 저장', description: '지금 ERD를 이름 붙인 버전으로 저장한다.', inputSchema: { project: projectArg, name: z.string() } },
    safe(async ({ project, name }: { project: string; name: string }) => {
      const p = await resolveProject(project);
      return text(await api.request('POST', `/api/projects/${p.id}/versions`, { name, source: 'ai' }));
    }),
  );

  server.registerTool(
    'list_versions',
    { title: '버전 목록', description: '저장된 버전 목록 (최신순).', inputSchema: { project: projectArg }, annotations: { readOnlyHint: true } },
    safe(async ({ project }: { project: string }) => {
      const p = await resolveProject(project);
      return text(await api.request('GET', `/api/projects/${p.id}/versions`));
    }),
  );

  server.registerTool(
    'diff_versions',
    {
      title: '버전 비교',
      description: '두 버전(또는 버전과 지금 ERD)의 차이를 보여준다.',
      inputSchema: { project: projectArg, from: z.string().describe('기준 버전 id'), to: z.string().optional().describe('비교할 버전 id. 생략하면 지금 ERD') },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ project, from, to }: { project: string; from: string; to?: string }) => {
      const p = await resolveProject(project);
      const q = new URLSearchParams({ from, ...(to ? { to } : {}) });
      return text(await api.request('GET', `/api/projects/${p.id}/diff?${q}`));
    }),
  );

  server.registerTool(
    'list_proposals',
    { title: '제안 목록', description: 'AI 제안과 승인 상태를 보여준다. 승인/거절은 사람이 화면에서 한다.', inputSchema: { project: projectArg }, annotations: { readOnlyHint: true } },
    safe(async ({ project }: { project: string }) => {
      const p = await resolveProject(project);
      return text(await api.request('GET', `/api/projects/${p.id}/proposals`));
    }),
  );

  server.registerTool(
    'undo_ai_changes',
    {
      title: 'AI 변경 되돌리기',
      description: '가장 최근 AI 작업(edit_schema·import_ddl·db_pull 한 번)으로 바로 적용한 변경을 거꾸로 되돌린다. 그 사이 사람이 고친 다른 부분은 그대로 둔다. 여러 번 부르면 한 단계씩 더 되돌린다. 사용자가 되돌려 달라고 할 때만 쓴다.',
      inputSchema: { project: projectArg },
      annotations: { destructiveHint: true },
    },
    safe(async ({ project }: { project: string }) => {
      const p = await resolveProject(project);
      return text(await api.request('POST', `/api/projects/${p.id}/ai/undo`));
    }),
  );

  server.registerTool(
    'list_connections',
    { title: 'DB 연결 목록', description: '화면에서 등록한 DB 연결 목록 (비밀번호 제외).', inputSchema: {}, annotations: { readOnlyHint: true } },
    safe(async () => text(await api.request('GET', '/api/connections'))),
  );

  server.registerTool(
    'create_connection',
    {
      title: 'DB 연결 만들기',
      description: [
        'DB 연결 정보를 저장한다. 저장하기 전에 실제로 접속해 확인한다 (실패하면 저장하지 않는다).',
        '비밀번호는 서버에 암호화해 저장하고 결과에는 나오지 않는다.',
        '로컬·자체 설치 서버에서 쓴다. 웹 서비스(배포 서버)는 사용자 PC·사내망 DB에 접속할 수 없어 설치형 앱에서 연결해야 한다.',
      ].join(' '),
      inputSchema: {
        name: z.string().describe('연결 이름 (예: 로컬 MySQL)'),
        dialect: dialectArg,
        host: z.string(),
        port: z.number().int(),
        database: z.string().describe('데이터베이스 이름 (Oracle은 서비스 이름, 예: FREEPDB1)'),
        user: z.string(),
        password: z.string().optional(),
        schema: z.string().optional().describe('PostgreSQL·SQL Server 스키마 (기본 public·dbo)'),
      },
    },
    safe(async (input: { name: string; dialect: string; host: string; port: number; database: string; user: string; password?: string; schema?: string }) => {
      const tested = await api.request<{ serverVersion: string }>('POST', '/api/connections/test', input);
      const saved = await api.request<{ id: string; name: string }>('POST', '/api/connections', input);
      return text({ ...saved, serverVersion: tested.serverVersion });
    }),
  );

  server.registerTool(
    'db_pull',
    {
      title: 'DB에서 ERD 갱신',
      description: [
        '연결한 DB의 구조를 읽어 ERD와 비교한다. apply=false(기본)면 차이만 보여준다.',
        'apply=true면 ERD에 반영한다 (위치·논리명 유지). DB에 없는 ERD 테이블은 include_removals=true일 때만 지운다.',
      ].join(' '),
      inputSchema: { project: projectArg, connection: z.string().describe('연결 id 또는 이름'), apply: z.boolean().optional(), include_removals: z.boolean().optional(), mode },
    },
    safe(async (a: { project: string; connection: string; apply?: boolean; include_removals?: boolean; mode?: string }) => {
      const p = await resolveProject(a.project);
      const c = await resolveConnection(a.connection);
      return text(await api.request('POST', `/api/projects/${p.id}/db/pull`, { connectionId: c.id, apply: a.apply, includeRemovals: a.include_removals, mode: a.mode, source: 'ai' }));
    }),
  );

  server.registerTool(
    'db_push',
    {
      title: 'ERD를 DB에 반영',
      description: [
        'ERD와 DB를 비교해 바뀐 부분만 실행할 SQL(CREATE/ALTER/INDEX/FK)을 만든다. execute=false(기본)면 SQL만 보여준다.',
        '중요: execute=true로 실행하기 전에 반드시 SQL을 사용자에게 보여주고 명시적인 승인을 받는다.',
        '실행하려면 confirm_database에 데이터베이스 이름을 넣어야 하고, 프로젝트에서 "AI의 DB 실행 허용"이 켜져 있어야 한다.',
        '테이블 삭제(DROP)는 include_drop=true일 때만 포함한다.',
      ].join(' '),
      inputSchema: {
        project: projectArg,
        connection: z.string().describe('연결 id 또는 이름'),
        execute: z.boolean().optional(),
        include_drop: z.boolean().optional(),
        confirm_database: z.string().optional(),
      },
      annotations: { destructiveHint: true },
    },
    safe(async (a: { project: string; connection: string; execute?: boolean; include_drop?: boolean; confirm_database?: string }) => {
      const p = await resolveProject(a.project);
      const c = await resolveConnection(a.connection);
      const r = await api.request<{ script: string; changes: unknown[]; result?: unknown; database: string }>('POST', `/api/projects/${p.id}/db/push`, {
        connectionId: c.id,
        execute: a.execute,
        includeDrop: a.include_drop,
        confirmDatabase: a.confirm_database,
        source: 'ai',
      });
      return text({ database: r.database, changes: r.changes, sql: r.script || '-- 실행할 것 없음 (DB와 ERD가 같음)', result: r.result });
    }),
  );

  server.registerTool(
    'export_definition_excel',
    {
      title: '테이블 정의서 (Excel)',
      description: options.canWriteFiles
        ? '테이블 정의서 엑셀 파일을 만들어 output_path(기본: 현재 폴더)에 저장한다.'
        : '테이블 정의서 엑셀 파일의 다운로드 주소를 돌려준다.',
      inputSchema: {
        project: projectArg,
        output_path: z.string().optional(),
        layout: z.enum(['sheetPerTable', 'singleSheet']).optional(),
        area: z.string().optional().describe('주제영역 이름: 그 영역 테이블만 정의서로'),
        author: z.string().optional(),
        since_version: z.string().optional().describe('넣으면 이 버전 이후 변경 이력 시트를 추가'),
      },
    },
    safe(async (a: { project: string; output_path?: string; layout?: string; author?: string; since_version?: string; area?: string }) => {
      const p = await resolveProject(a.project);
      const q = new URLSearchParams();
      if (a.layout) q.set('layout', a.layout);
      if (a.author) q.set('author', a.author);
      if (a.since_version) q.set('since', a.since_version);
      if (a.area) q.set('area', a.area);
      const path = `/api/projects/${p.id}/definition.xlsx?${q}`;
      if (!options.canWriteFiles) return text({ download: `${api.webUrl ?? ''}${path}` });
      const buffer = await api.download(path);
      const file = resolve(a.output_path ?? `${`${p.name}${a.area ? `_${a.area}` : ''}`.replace(/[\\/:*?"<>|]+/g, '_')}_테이블정의서.xlsx`);
      writeFileSync(file, Buffer.from(buffer));
      return text({ saved: file, bytes: buffer.byteLength });
    }),
  );
}

/** token: 로그인 모드 서버에 연결할 때 쓰는 개인 액세스 토큰 (ERD_TOKEN) */
export function httpApi(baseUrl: string, token?: string): ErdApi {
  const base = baseUrl.replace(/\/$/, '');
  const call = async (method: string, path: string, body?: unknown) => {
    let res: Response;
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    try {
      res = await fetch(base + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new Error(`ERD 서버(${base})에 연결할 수 없습니다. ERD 폴더에서 npm run dev로 서버를 실행하세요.`);
    }
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (res.status === 401) throw new Error('ERD 서버가 로그인을 요구합니다. 화면의 AI 버튼에서 개인 토큰을 만들어 ERD_TOKEN 환경 변수로 넣으세요.');
      throw new Error(data.error ?? `요청 실패 (${res.status})`);
    }
    return res;
  };
  return {
    webUrl: process.env.ERD_WEB_URL ?? 'http://localhost:5173',
    request: async <T>(method: string, path: string, body?: unknown) => (await (await call(method, path, body)).json()) as T,
    download: async (path: string) => (await call('GET', path)).arrayBuffer(),
  };
}

/** 검토가 필요한 테이블 안내 (없으면 undefined) */
function reviewNeeded(schema: Schema, review: AiReview | null): string | undefined {
  if (!schema.tables.length) return undefined;
  const pending = unreviewedTables(schema, review);
  if (pending === null) return '아직 AI 설계 검토가 없습니다. 이번 설계 작업을 마치면 ERD 전체를 검토해 save_design_review로 저장하세요.';
  if (!pending.length) return undefined;
  const names = pending.length > 30 ? `${pending.slice(0, 30).join(', ')} 외 ${pending.length - 30}개` : pending.join(', ');
  return `AI 검토 이후 바뀐 테이블 ${pending.length}개: ${names}. 이번 설계 작업을 마치면 이 테이블들(과 관계 상대)을 검토해 save_design_review(tables에 이 이름들)로 저장하세요.`;
}
