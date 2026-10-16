// ERD MCP 도구. AI가 ERD를 읽고, 고치고, SQL·정의서를 만들고, DB와 동기화한다.
// 모든 동작은 ERD 서버 API를 거치므로 화면을 보고 있는 사람에게 변경이 실시간으로 보인다.

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { diagnoseDbError, areaSchema, describeMatch, describeSchema, dialects, FEATURE_LABEL, getDialect, type FeatureKey, dictIndex, describeNaming, lookupTerm, NAME_KIND_LABEL, readNamingSetting, type NameKind, searchDictionary, splitDictType, type Dictionary, NAME_STYLE_EXAMPLE, NAME_STYLE_LABEL, projectNamingStyles, requireArea, LINT_RULES, lintSchema, generateSeedData, seedScript, reviewItemState, unreviewedTables, type AiReview, type DialectId, type Schema } from '@erd/core';

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

const dbObjectKind = z.enum(['view', 'materializedView', 'function', 'procedure', 'trigger', 'event', 'package', 'packageBody']);

const areaColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/)
  .optional()
  .describe('영역 색 (#rrggbb). 생략하면 옆 영역과 구분되는 색을 차례로 준다. 흰 글자가 잘 보이는 진한 색 (예: #2563eb, #059669, #ea580c, #9333ea)');
const colorTables = z
  .boolean()
  .optional()
  .describe('영역 색을 그 영역 테이블 색으로도 칠한다 (기본 true). 여러 영역에 들어 있는 공통 테이블은 첫 영역(탭 순서)의 색을 쓴다');

const columnSpec = z.object({
  name: z.string().describe('물리명 (예: member_id)'),
  logicalName: z.string().optional().describe('논리명 (예: 회원번호)'),
  type: z.string().optional().describe('타입. 길이를 붙여도 된다 (예: VARCHAR(100), DECIMAL(12,2), BIGINT). 사용자 정의 타입(ENUM)은 그 이름 (예: order_status)'),
  nullable: z.boolean().optional().describe('NULL 허용 (기본 true)'),
  primaryKey: z.boolean().optional(),
  unique: z.boolean().optional(),
  autoIncrement: z.boolean().optional(),
  default: z.string().nullable().optional().describe("SQL 식 그대로. 문자열은 따옴표 포함 (예: 'Y', 0, CURRENT_TIMESTAMP)"),
  onUpdate: z.string().nullable().optional().describe('MySQL·MariaDB 전용: 행이 바뀔 때 넣는 값 (예: CURRENT_TIMESTAMP). null이면 해제'),
  generated: z.string().nullable().optional().describe('계산 컬럼 식 (예: qty * price). null이면 일반 컬럼으로'),
  generatedStored: z.boolean().optional().describe('계산 값을 저장(STORED)할지. 기본 VIRTUAL (PostgreSQL은 STORED만, Oracle은 VIRTUAL만)'),
  comment: z.string().optional().describe('상세 설명 — ERD에만 저장 (DB comment에는 logicalName이 들어간다)'),
  privacy: z.enum(['unique', 'password', 'financial', 'sensitive', 'personal']).nullable().optional().describe('개인정보 표시 (ERD에만 저장): unique 고유식별정보(주민·여권·운전면허·외국인등록번호), password 비밀번호, financial 계좌·카드번호, sensitive 민감정보(건강·종교 등), personal 이름·연락처·이메일·주소·생년월일·IP. null이면 해제'),
  encrypted: z.boolean().optional().describe('개인정보를 암호화(비밀번호는 해시)해서 저장하는지. unique·password·financial은 법으로 암호화해야 한다'),
});

const command = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('createTable'),
    name: z.string(),
    logicalName: z.string().optional(),
    comment: z.string().optional().describe('상세 설명 — ERD에만 저장 (DB comment에는 logicalName)'),
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
  z.object({ op: z.literal('dropRelation'), parent: z.string(), child: z.string(), name: z.string().optional().describe('외래키 이름 (같은 두 테이블 사이에 관계가 여럿일 때 고름)'), dropColumns: z.boolean().optional() }),
  z.object({
    op: z.literal('updateRelation'),
    parent: z.string(),
    child: z.string(),
    name: z.string().optional().describe('지금 외래키 이름 (get_schema relations의 name. 같은 두 테이블 사이에 관계가 여럿일 때 고름)'),
    newName: z.string().optional().describe('새 외래키 이름 (다른 외래키가 쓰는 이름은 안 됨)'),
    cardinality: z.enum(['1:N', '1:1']).optional(),
    onDelete: referentialAction.optional(),
    onUpdate: referentialAction.optional(),
  }),
  // 주제영역: 큰 ERD를 기능별로 나눠 보는 탭 (화면 구분일 뿐 SQL·DB에는 영향 없음). 같은 테이블을 여러 영역에 넣을 수 있다
  z.object({
    op: z.literal('createArea'),
    name: z.string().describe('영역 이름 (예: 주문, 회원, 정산)'),
    tables: z.array(z.string()).optional().describe('처음 넣을 테이블'),
    color: areaColor,
    colorTables: colorTables,
  }),
  z.object({
    op: z.literal('updateArea'),
    area: z.string(),
    name: z.string().optional().describe('새 이름'),
    color: areaColor,
    colorTables: z
      .boolean()
      .optional()
      .describe('true: 이미 있는 영역의 테이블을 모두 영역 색으로 칠한다 (색을 안 바꿔도. "기존 영역에 테이블 색 맞춰줘"일 때). 생략: 영역 색을 바꿀 때 그 색을 따르던 테이블만 함께 바꾼다. false: 테이블 색은 그대로'),
  }),
  z.object({ op: z.literal('dropArea'), area: z.string().describe('지울 영역 (테이블은 남는다)') }),
  z.object({ op: z.literal('addToArea'), area: z.string(), tables: z.array(z.string()).min(1).describe('넣을 테이블 (다른 영역에도 그대로 남는다)'), colorTables: colorTables }),
  z.object({ op: z.literal('removeFromArea'), area: z.string(), tables: z.array(z.string()).min(1).describe('영역에서 뺄 테이블 (테이블은 남는다)') }),
  // 사용자 정의 타입 (ENUM): 허용 값 목록. 컬럼 type에 이 이름을 쓴다.
  // PostgreSQL은 CREATE TYPE으로, MySQL·MariaDB는 컬럼마다 ENUM(...)으로, Oracle·SQL Server는 VARCHAR로 만든다
  z.object({
    op: z.literal('createEnum'),
    name: z.string().describe('타입 이름 (예: order_status). 프로젝트 이름 표기 기준을 따른다'),
    values: z.array(z.string()).min(1).describe("허용 값 (순서대로. 예: ['READY', 'PAID', 'CANCELED'])"),
    comment: z.string().optional().describe('설명 (ERD에만 저장)'),
  }),
  z.object({
    op: z.literal('updateEnum'),
    enum: z.string().describe('고칠 타입 이름'),
    name: z.string().optional().describe('새 이름 (쓰는 컬럼의 타입도 함께 바뀐다)'),
    values: z.array(z.string()).min(1).optional().describe('새 값 목록 전체 (PostgreSQL에서 값을 빼거나 순서를 바꾸면 타입을 다시 만든다)'),
    comment: z.string().optional(),
  }),
  z.object({ op: z.literal('dropEnum'), enum: z.string().describe('지울 타입 (쓰던 컬럼은 VARCHAR로 바뀐다)') }),
  // DB 객체 (뷰·함수·프로시저·트리거·이벤트·패키지): 그 DB 문법의 CREATE 문 그대로. 종류·이름은 DDL에서 읽는다
  z.object({ op: z.literal('createObject'), definition: z.string().describe('CREATE VIEW / FUNCTION / PROCEDURE / TRIGGER … 전체 DDL (프로젝트 DB 문법)'), comment: z.string().optional() }),
  z.object({
    op: z.literal('updateObject'),
    name: z.string().describe('고칠 객체 이름'),
    kind: dbObjectKind.optional().describe('같은 이름이 여러 종류일 때'),
    definition: z.string().optional().describe('새 CREATE 문 전체 (get_db_objects로 지금 DDL을 읽고 고친다)'),
    comment: z.string().optional(),
  }),
  z.object({ op: z.literal('dropObject'), name: z.string(), kind: dbObjectKind.optional() }),
  z.object({
    op: z.literal('moveToArea'),
    area: z.string().describe('옮겨 갈 영역'),
    tables: z.array(z.string()).min(1),
    from: z.string().optional().describe('이 영역에서만 뺀다. 생략하면 다른 모든 영역에서 빼고 이 영역에만 둔다'),
    colorTables: colorTables,
  }),
]);

/** DB 가져오기·내보내기 기록 (서버 /db/log) */
interface DbLogEntry {
  id: string;
  at: string;
  by?: string;
  action: 'pull' | 'push' | 'seed';
  stage: 'compare' | 'safety' | 'execute' | 'apply';
  via: 'screen' | 'server';
  ok: boolean;
  connection: { name: string; dialect: string; database: string; serverVersion?: string };
  error?: string;
  results?: { sql: string; ok: boolean; skipped?: boolean; error?: string }[];
  rolledBack?: boolean;
  appliedCount?: number;
  warnings?: string[];
}

const DB_STAGE = { compare: 'DB 읽기·비교', safety: '실행 전 안전 검사', execute: 'SQL 실행', apply: 'ERD에 반영' } as const;

/** AI가 읽기 좋게: 실패한 문장과 그 전에 실행된 문장, 실행되지 않은 문장 수 */
function describeDbLog(e: DbLogEntry) {
  const results = e.results ?? [];
  const failedAt = results.findIndex((r) => !r.ok && !r.skipped);
  const ran = results.filter((r) => r.ok);
  return {
    at: e.at,
    by: e.by,
    action: e.action === 'pull' ? 'DB에서 가져오기' : e.action === 'seed' ? '테스트 데이터 넣기' : 'DB로 내보내기',
    stage: DB_STAGE[e.stage],
    via: e.via === 'screen' ? '화면(설치형 앱이 DB에 접속)' : '서버(AI 등)',
    ok: e.ok,
    connection: e.connection,
    error: e.error,
    failedStatements: results.filter((r) => !r.ok && !r.skipped).map((r) => ({ index: results.indexOf(r) + 1, sql: r.sql, error: r.error })),
    // 실패 바로 앞에 실행된 문장 몇 개 (순서가 원인일 때 보이게)
    executedBefore: failedAt > 0 ? results.slice(Math.max(0, failedAt - 5), failedAt).filter((r) => r.ok).map((r) => r.sql) : undefined,
    totals: results.length ? { statements: results.length, succeeded: ran.length, notRun: results.filter((r) => r.skipped).length } : undefined,
    rolledBack: e.rolledBack,
    appliedCount: e.appliedCount,
    note: e.rolledBack === false && (e.appliedCount ?? 0) > 0 && !e.ok ? '일부 문장은 DB에 반영된 채 멈췄습니다 (이 DB는 DDL을 되돌리지 못함). 다시 비교하면 남은 변경만 나옵니다.' : undefined,
    warnings: e.warnings,
  };
}

const escapeRegex = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 오류 문장·SQL에 이름이 나온 테이블과, 그 테이블과 관계로 이어진 테이블의 지금 ERD 정의 */
export function relatedSchema(schema: Schema, text: string) {
  const mentioned = new Set(
    schema.tables.filter((t) => new RegExp(`(^|[^A-Za-z0-9_$])${escapeRegex(t.name)}([^A-Za-z0-9_$]|$)`, 'i').test(text)).map((t) => t.id),
  );
  if (!mentioned.size) return undefined;
  const ids = new Set(mentioned);
  for (const r of schema.relations) {
    if (mentioned.has(r.fromTableId)) ids.add(r.toTableId);
    if (mentioned.has(r.toTableId)) ids.add(r.fromTableId);
  }
  const { areas: _areas, ...described } = describeSchema({
    ...schema,
    tables: schema.tables.filter((t) => ids.has(t.id)),
    relations: schema.relations.filter((r) => ids.has(r.fromTableId) && ids.has(r.toTableId)),
    areas: [],
  });
  return described;
}

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
    d
      ? `표준 용어 사전 있음 (용어 ${d.terms.length}개): 테이블·컬럼을 만들거나 이름을 바꿀 때 lookup_dictionary로 논리명의 표준 물리명·타입·길이를 찾아 그대로 씁니다. 사전에 없는 용어는 반영할 때 사전에 자동으로 추가됩니다`
      : undefined;
  /** 이 프로젝트 DB에 있는 기능·없는 기능 (없는 기능은 명령이 거절된다) */
  const featuresInfo = (dialectId: string) => {
    const features = getDialect(dialectId as DialectId).features;
    const keys = Object.keys(FEATURE_LABEL) as FeatureKey[];
    return {
      available: keys.filter((k) => features[k]).map((k) => FEATURE_LABEL[k]),
      notAvailable: keys.filter((k) => !features[k]).map((k) => FEATURE_LABEL[k]),
    };
  };
  /** 프로젝트의 이름 표기 기준 안내 (AI가 같은 표기로 만들게) */
  const namingInfo = (meta: Record<string, unknown>, schema: Schema, dict: Dictionary | null) => {
    const r = projectNamingStyles(meta.namingStyle, schema, dict ? dictIndex(dict).styles : null);
    const one = (k: NameKind) => {
      const { style, from } = r[k];
      if (!style) return '아직 정해지지 않음 — 처음 만드는 표기(snake_case 권장)가 기준으로 저장됩니다';
      const why = from === 'dictionary' ? ' — 용어 사전의 표기' : from === 'names' ? ' — 지금 이름들로 판단' : '';
      return `${NAME_STYLE_LABEL[style]} (예: ${NAME_STYLE_EXAMPLE[style]})${why}`;
    };
    if (r.table.style === r.column.style && r.table.from === r.column.from) return `${one('table')}. 테이블·컬럼 물리명을 모두 이 표기로 만드세요`;
    // 테이블과 컬럼의 기준이 다를 수 있다 (예: 테이블 camelCase, 컬럼 snake_case)
    return `${NAME_KIND_LABEL.table}: ${one('table')} / ${NAME_KIND_LABEL.column}: ${one('column')}. 테이블 이름과 컬럼 이름을 각자 이 표기로 만드세요`;
  };

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
      const dict = await dictionaryOf(p.id);
      const info = { id: p.id, name: meta.name, dialect: meta.dialect, aiMode: meta.aiMode, url: link(p.id), namingStyle: namingInfo(meta, schema, dict), dictionary: dictionaryHint(dict), features: featuresInfo(String(meta.dialect ?? 'mysql')) };
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
      const all = lintSchema(schema, String(meta.dialect ?? 'mysql'), { namingStyle: readNamingSetting(meta.namingStyle), dictionary: await dictionaryOf(p.id) }).filter((i) => inScope(i.tableName));
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
        '결과의 naming: 이번에 만들거나 바꾼 이름 중 프로젝트 표기 기준(snake_case 등)과 다른 것 — 안내대로 updateTable·updateColumn으로 바로 고친다. namingStyleSaved: 기준이 없던 쪽(테이블·컬럼 따로)에 이번 이름들로 기준을 저장함 (다음부터 이 기준을 따른다).',
        '결과의 terms: 지금 ERD를 표준 용어 사전에 넣을 때(사전 화면의 "ERD에서 만들기"와 같은 검사) 걸리는 것 — 사전이 없어도 나온다. 같은 논리명(같은 뜻)을 다른 물리명·타입으로 쓴 곳, 사전 표기와 다른 이름, 사전에 넣을 수 없게 겹치는 이름. 같은 뜻이면 안내대로 updateColumn으로 맞추고, 다른 뜻이면 논리명을 구분한다. 논리명이 다르면 물리명이 같아도 된다 (예: 결제상태·구독상태 → status).',
        '결과의 dictionary: 표준 용어 사전과 다른 컬럼·테이블 — 안내대로 updateColumn·updateTable 한다. dictionaryAdded: 사전에 없어 이번에 사전에 새로 넣은 용어 (같은 논리명이 이미 있거나 표기 기준과 다르면 넣지 않음).',
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
    'get_db_objects',
    {
      title: 'DB 객체 읽기 (뷰·함수·프로시저 등)',
      description: [
        '프로젝트의 DB 객체(뷰·구체화 뷰·함수·프로시저·트리거·이벤트·패키지)의 전체 DDL을 읽는다. get_schema의 objects에는 종류·이름만 나온다.',
        '고칠 때는 이 DDL을 고쳐 edit_schema의 updateObject(definition)로 넣고, 새로 만들 때는 createObject, 지울 때는 dropObject. 그 뒤 db_push로 DB에 반영한다 (바뀐 것만 지웠다 다시 만든다).',
        'DB에 이미 있는 객체는 화면의 DB에서 가져오기로 ERD에 들어온다. 다룰 수 있는 종류는 DB마다 다르다 (kinds).',
      ].join(' '),
      inputSchema: { project: projectArg, kind: dbObjectKind.optional(), names: z.array(z.string()).optional().describe('이 이름들만 (생략하면 전부)') },
      annotations: { readOnlyHint: true },
    },
    safe(async (a: { project: string; kind?: string; names?: string[] }) => {
      const p = await resolveProject(a.project);
      const { meta, schema } = await api.request<{ meta: Record<string, unknown>; schema: Schema }>('GET', `/api/projects/${p.id}`);
      const kinds = getDialect(String(meta.dialect ?? 'mysql') as DialectId).features.objects?.kinds ?? [];
      const wanted = a.names?.map((n) => n.toLowerCase());
      const objects = (schema.objects ?? []).filter((o) => (!a.kind || o.kind === a.kind) && (!wanted || wanted.includes(o.name.toLowerCase())));
      return text({ dialect: meta.dialect, kinds, objects: objects.map(({ id: _id, ...o }) => o) });
    }),
  );

  server.registerTool(
    'lookup_dictionary',
    {
      title: '표준 용어 사전 찾기',
      description: [
        '프로젝트의 표준 용어 사전(사람이 엑셀로 올린 것)에서 논리명의 표준 물리명·타입·길이를 찾는다.',
        'names에 만들 컬럼의 논리명들(예: ["회원번호","주문금액"])을 주면 각각의 표준 물리명·타입을 알려 준다. 사전에 없으면 null.',
        'tables에 만들 테이블의 논리명들(예: ["회원","주문"])을 주면 사전의 표준 테이블 물리명을 알려 준다 (테이블 용어는 타입 없음). 사전에 있는 테이블 이름과 같은 테이블은 두 번 만들지 않는다.',
        'query로 사전을 검색할 수도 있다 (비슷한 용어 찾기). 사전이 없으면 사전 없이 평소대로 설계한다.',
      ].join(' '),
      inputSchema: {
        project: projectArg,
        names: z.array(z.string()).optional().describe('찾을 컬럼 논리명들'),
        tables: z.array(z.string()).optional().describe('찾을 테이블 논리명들'),
        query: z.string().optional().describe('사전 검색어 (논리명·물리명·설명에 들어 있는 것)'),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ project, names, tables, query }: { project: string; names?: string[]; tables?: string[]; query?: string }) => {
      const p = await resolveProject(project);
      const dict = await dictionaryOf(p.id);
      if (!dict) return text('이 프로젝트에는 표준 용어 사전이 없습니다. 사전 없이 평소대로 설계하세요 (사람이 화면의 "용어 사전"에서 엑셀로 올릴 수 있음).');
      const index = dictIndex(dict);
      const typeText = (type?: string, length?: string) => {
        const st = splitDictType(type, length);
        return st.type ? `${st.type}${st.length ? `(${st.length})` : ''}` : undefined;
      };
      const term = (t: { kind?: string; logical: string; physical: string; type?: string; length?: string; description?: string }) => ({ kind: t.kind === 'table' ? '테이블' : '컬럼', logicalName: t.logical, name: t.physical, type: typeText(t.type, t.length), description: t.description });
      return text({
        dictionary: `용어 ${dict.terms.length}개 (테이블 ${index.tables.size}), 물리명 표기(프로젝트 기준): ${describeNaming(index.styles)} — 사전에 없는 테이블·컬럼도 이 표기로 이름을 짓는다`,
        tableResults: tables?.length
          ? tables.map((n) => {
              const t = index.tables.get(n.replace(/\s+/g, '').toLowerCase());
              return t ? { logicalName: n, name: t.physical } : { logicalName: n, standard: null, note: '사전에 없음 — 사전 표기로 이름을 지으면 반영될 때 사전에 추가된다' };
            })
          : undefined,
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
      description: 'CREATE TABLE 등 DDL을 읽어 ERD에 합친다. 같은 이름의 테이블은 갱신하고, DDL에 없는 테이블은 지우지 않는다. 프로젝트 DB 종류의 DDL만 받는다 (다른 DB의 DDL은 거절 — DB 종류는 바꾸거나 변환하지 않는다).',
      inputSchema: { project: projectArg, sql: z.string(), mode },
    },
    safe(async ({ project, sql, mode: m }: { project: string; sql: string; mode?: string }) => {
      const p = await resolveProject(project);
      const result = await api.request<Record<string, unknown>>('POST', `/api/projects/${p.id}/import-ddl`, { sql, mode: m, source: 'ai' });
      return text({ ...result, designReview: await reviewReminder(p.id) });
    }),
  );

  server.registerTool(
    'export_sql',
    {
      title: 'SQL 만들기',
      description: 'ERD로 SQL을 만든다 (프로젝트 DB 종류의 문법으로만). since_version을 주면 그 버전 이후 바뀐 부분만 ALTER/CREATE로 만든다 (CREATE/ALTER/DROP 구분 포함).',
      inputSchema: { project: projectArg, since_version: z.string().optional().describe('버전 id (list_versions로 확인)') },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ project, since_version }: { project: string; since_version?: string }) => {
      const p = await resolveProject(project);
      const q = new URLSearchParams();
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
    'get_db_errors',
    {
      title: 'DB 작업 오류 보기',
      description: [
        'DB에서 가져오기·DB로 내보내기에서 난 오류를 읽는다 (화면·설치형 앱에서 사람이 한 작업과 db_pull·db_push 모두).',
        '실패한 SQL과 DB 오류 메시지, 그 전에 실행된 문장, 되돌림 여부, DB 버전, 오류에 나온 테이블의 지금 ERD 정의(relatedTables)를 함께 준다.',
        '사용자가 DB 오류 원인을 물으면 이것으로 원인을 분석해 쉬운 말로 설명하고, ERD를 고쳐야 하면 edit_schema로 고치는 방법을 제안한다.',
        '다시 실행은 사람이 화면의 "DB로 내보내기"에서 하거나, db_push(execute=true)는 SQL을 보여 주고 승인받은 뒤에만 한다.',
      ].join(' '),
      inputSchema: {
        project: projectArg,
        include_success: z.boolean().optional().describe('성공한 작업도 함께 (기본: 실패한 것만)'),
        limit: z.number().int().min(1).max(20).optional().describe('최근 몇 건 (기본 3)'),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async (a: { project: string; include_success?: boolean; limit?: number }) => {
      const p = await resolveProject(a.project);
      const entries = await api.request<DbLogEntry[]>('GET', `/api/projects/${p.id}/db/log?limit=${a.limit ?? 3}${a.include_success ? '' : '&failed=1'}`);
      if (!entries.length) return text({ project: p.name, entries: [], message: a.include_success ? 'DB 작업 기록이 없습니다.' : '최근 DB 작업 오류가 없습니다.' });
      const { meta, schema } = await api.request<{ meta: Record<string, unknown>; schema: Schema }>('GET', `/api/projects/${p.id}`);
      const failedText = entries.flatMap((e) => [e.error ?? '', ...(e.results ?? []).filter((r) => !r.ok && !r.skipped).flatMap((r) => [r.sql, r.error ?? ''])]).join('\n');
      return text({
        project: { name: meta.name, dialect: meta.dialect },
        entries: entries.map(describeDbLog),
        relatedTables: relatedSchema(schema, failedText),
      });
    }),
  );

  // ── DB 연결·내보내기 ─────────────────────────────
  // 웹 서비스는 서버가 사용자 PC·사내망 DB에 접속하지 않는다: 이 작업들은 사용자가 열어 둔 ERD 앱(설치형 앱)에 넘겨
  // 앱이 직접 접속해 처리하고 결과를 돌려준다 (/api/db-jobs). 로컬·자체 설치 서버는 연결 관리를 서버가 바로 한다.
  let serverDbCache: boolean | null = null;
  const serverDb = async () => (serverDbCache ??= (await api.request<{ serverDb?: boolean }>('GET', '/api/me')).serverDb !== false);
  type JobResult = { id: string; status: string; projectId?: string; result?: Record<string, unknown>; error?: string };
  /** 앱에 작업을 넘기고 끝날 때까지 기다린다 */
  const viaApp = async (kind: string, payload: Record<string, unknown>, projectId?: string, wait = 100): Promise<JobResult> => {
    const job = await api.request<JobResult>('POST', '/api/db-jobs', { kind, payload, projectId, wait });
    if (job.status === 'failed' && !job.result) throw new Error(job.error ?? 'DB 작업이 실패했습니다');
    return job;
  };
  /** 접속 오류에 원인·조치·누가 고칠지를 붙인다 */
  const connectFailure = (error: string, stage: 'connect' | 'execute' = 'connect') => ({
    ok: false,
    error,
    diagnosis: diagnoseDbError(error, stage) ?? { cause: '알 수 없는 오류입니다 (원문을 보고 판단)', fix: '오류 원문을 사용자에게 보여 주고 확인을 받으세요', actor: 'user' },
    guide: 'diagnosis.actor가 ai면 연결 정보(호스트·포트·DB 이름·SSL)를 고쳐 update_connection으로 다시 시도하고, user면 무엇을 해야 하는지 사용자에게 알려 주세요. 비밀번호는 추측하지 말고 사용자에게 받으세요.',
  });
  const connectionArgs = {
    name: z.string().describe('연결 이름 (예: 로컬 MySQL)'),
    dialect: dialectArg,
    host: z.string(),
    port: z.number().int(),
    database: z.string().describe('데이터베이스 이름 (Oracle은 서비스 이름, 예: FREEPDB1)'),
    user: z.string(),
    password: z.string().optional().describe('비밀번호 (사용자가 알려 준 것만. 추측하지 않는다)'),
    schema: z.string().optional().describe('PostgreSQL·SQL Server 스키마 (기본 public·dbo)'),
    ssl: z.boolean().optional(),
  };
  type ConnInput = { name: string; dialect: string; host: string; port: number; database: string; user: string; password?: string; schema?: string; ssl?: boolean };

  server.registerTool(
    'list_connections',
    { title: 'DB 연결 목록', description: '등록한 DB 연결 목록 (비밀번호 제외). 웹 서비스에서는 사용자 PC의 ERD 앱에 저장된 연결을 읽는다 (앱이 켜져 있어야 함).', inputSchema: {}, annotations: { readOnlyHint: true } },
    safe(async () => {
      if (await serverDb()) return text(await api.request('GET', '/api/connections'));
      return text((await viaApp('listConnections', {}, undefined, 30)).result?.connections ?? []);
    }),
  );

  server.registerTool(
    'create_connection',
    {
      title: 'DB 연결 만들기',
      description: [
        'DB 연결을 만든다. 저장하기 전에 항상 실제로 접속해 확인하고, 실패하면 저장하지 않고 원인(diagnosis: 원인·조치·누가 고칠지)을 돌려준다.',
        '비밀번호는 암호화해 저장하고 결과에는 나오지 않는다. 웹 서비스에서는 사용자 PC의 ERD 앱이 접속해 확인·저장한다 (앱이 켜져 있어야 함).',
        'project를 주면 그 프로젝트의 DB 연결로 정한다 (DB 종류가 같아야 함).',
      ].join(' '),
      inputSchema: { ...connectionArgs, project: projectArg.optional() },
    },
    safe(async (a: ConnInput & { project?: string }) => {
      const { project, ...input } = a;
      const p = project ? await resolveProject(project) : null;
      if (p && p.dialect !== input.dialect) throw new Error(`프로젝트 ${p.name}은(는) ${p.dialect} 프로젝트입니다. 같은 DB 종류의 연결만 쓸 수 있습니다`);
      if (await serverDb()) {
        try {
          const tested = await api.request<{ serverVersion: string }>('POST', '/api/connections/test', input);
          const saved = await api.request<{ id: string; name: string }>('POST', '/api/connections', input);
          if (p) await api.request('PATCH', `/api/projects/${p.id}`, { dbConnectionId: saved.id });
          return text({ ok: true, connection: saved, serverVersion: tested.serverVersion, linkedProject: p?.name });
        } catch (e) {
          return { ...text(connectFailure(e instanceof Error ? e.message : String(e))), isError: true };
        }
      }
      const { password, ...rest } = input;
      const job = await viaApp('saveConnection', { input: rest, password, projectId: p?.id }, p?.id, 60);
      const r = job.result ?? {};
      if (!r.ok) return { ...text(connectFailure(String(r.error ?? job.error))), isError: true };
      return text({ ...r, linkedProject: p?.name });
    }),
  );

  server.registerTool(
    'update_connection',
    {
      title: 'DB 연결 고치기',
      description: [
        '이미 있는 DB 연결의 호스트·포트·DB 이름·사용자·비밀번호·SSL 등을 바꾼다. 바꾼 값으로 항상 먼저 접속해 확인하고, 실패하면 바꾸지 않고 원인(diagnosis)을 돌려준다.',
        '비밀번호를 주지 않으면 저장된 비밀번호를 그대로 쓴다.',
      ].join(' '),
      inputSchema: {
        connection: z.string().describe('고칠 연결 id 또는 이름'),
        name: z.string().optional(),
        host: z.string().optional(),
        port: z.number().int().optional(),
        database: z.string().optional(),
        user: z.string().optional(),
        password: z.string().optional().describe('새 비밀번호 (사용자가 알려 준 것만)'),
        schema: z.string().optional(),
        ssl: z.boolean().optional(),
      },
    },
    safe(async (a: { connection: string } & Partial<ConnInput>) => {
      const { connection, password, ...changes } = a;
      if (await serverDb()) {
        const c = await resolveConnection(connection);
        const input = { ...(c as unknown as ConnInput), ...changes, ...(password ? { password } : {}) };
        try {
          const tested = await api.request<{ serverVersion: string }>('POST', '/api/connections/test', { ...input, id: c.id });
          const saved = await api.request('PUT', `/api/connections/${c.id}`, input);
          return text({ ok: true, connection: saved, serverVersion: tested.serverVersion });
        } catch (e) {
          return { ...text(connectFailure(e instanceof Error ? e.message : String(e))), isError: true };
        }
      }
      const job = await viaApp('saveConnection', { ref: connection, input: changes, password }, undefined, 60);
      const r = job.result ?? {};
      if (!r.ok) return { ...text(connectFailure(String(r.error ?? job.error))), isError: true };
      return text(r);
    }),
  );

  server.registerTool(
    'test_connection',
    {
      title: 'DB 연결 확인',
      description: '저장된 DB 연결로 실제로 접속해 본다. 실패하면 원인(diagnosis: 원인·조치·누가 고칠지)을 돌려준다.',
      inputSchema: { connection: z.string().describe('연결 id 또는 이름') },
      annotations: { readOnlyHint: true },
    },
    safe(async (a: { connection: string }) => {
      if (await serverDb()) {
        const c = await resolveConnection(a.connection);
        try {
          const tested = await api.request<{ serverVersion: string }>('POST', '/api/connections/test', { ...(c as unknown as ConnInput), id: c.id });
          return text({ ok: true, connection: c.name, serverVersion: tested.serverVersion });
        } catch (e) {
          return { ...text(connectFailure(e instanceof Error ? e.message : String(e))), isError: true };
        }
      }
      const r = (await viaApp('testConnection', { ref: a.connection }, undefined, 40)).result ?? {};
      if (!r.ok) return { ...text(connectFailure(String(r.error))), isError: true };
      return text(r);
    }),
  );

  server.registerTool(
    'db_pull',
    {
      title: 'DB에서 가져오기',
      description: [
        '연결한 DB의 구조(테이블·컬럼·인덱스·관계·ENUM·뷰·함수 등 DB 객체)를 읽어 ERD와 비교한다. 사용자의 ERD 앱이 사용자 PC에서 로컬로 DB에 접속해 읽는다 (앱이 켜져 있어야 함).',
        'apply=false(기본)면 차이만 보여준다. apply=true면 ERD에 반영한다 (화면의 DB에서 가져오기와 같은 규칙: DB에서 바뀐 것만, 위치·논리명 유지, 빈 ERD면 자동 배치). DB에 없는 ERD 테이블은 include_removals=true일 때만 지운다.',
        '제안 모드 프로젝트는 반영이 제안으로 쌓여 사람이 승인한다. connection을 생략하면 프로젝트에 연결된 DB.',
        '반영 결과의 unassignedTables(아직 주제영역에 없는 테이블)가 많으면 기능별로 createArea·addToArea로 묶고 영역마다 auto_layout(area)한다.',
      ].join(' '),
      inputSchema: { project: projectArg, connection: z.string().optional().describe('연결 id 또는 이름 (생략하면 프로젝트에 연결된 DB)'), apply: z.boolean().optional(), include_removals: z.boolean().optional(), mode },
    },
    safe(async (a: { project: string; connection?: string; apply?: boolean; include_removals?: boolean; mode?: string }) => {
      const p = await resolveProject(a.project);
      let r: Record<string, unknown>;
      if (await serverDb()) {
        const c = a.connection ? await resolveConnection(a.connection) : null;
        const { meta } = await api.request<{ meta: Record<string, unknown> }>('GET', `/api/projects/${p.id}`);
        const connectionId = c?.id ?? (meta.dbConnectionId as string | undefined);
        if (!connectionId) throw new Error('이 프로젝트에 연결된 DB가 없습니다. connection으로 연결을 고르거나 create_connection으로 만드세요');
        r = await api.request('POST', `/api/projects/${p.id}/db/pull`, { connectionId, apply: a.apply, includeRemovals: a.include_removals, mode: a.mode, source: 'ai' });
      } else {
        const job = await viaApp('pull', { ref: a.connection, apply: Boolean(a.apply), includeRemovals: Boolean(a.include_removals), mode: a.mode }, p.id, 100);
        r = job.result ?? {};
        if (r.ok === false) return { ...text({ ...connectFailure(String(r.error)), stage: 'DB 읽기' }), isError: true };
      }
      const unassigned = Array.isArray(r.unassignedTables) ? (r.unassignedTables as string[]) : [];
      const guide = a.apply && r.mode !== 'propose' && unassigned.length >= 6
        ? `주제영역에 없는 테이블이 ${unassigned.length}개입니다. 이름·관계를 보고 기능별(예: 회원·주문·결제)로 edit_schema의 createArea·addToArea로 묶고, 영역마다 auto_layout(area)로 정리하세요.`
        : undefined;
      return text({ ...r, ...(guide ? { guide } : {}) });
    }),
  );

  /** 내보내기 결과를 AI가 바로 조치할 수 있게: 실패한 문장마다 원인·조치·누가 고칠지 + 관련 테이블 정의 */
  const pushReport = async (projectId: string, job: JobResult) => {
    const r = (job.result ?? {}) as {
      executed?: boolean; ok?: boolean; rolledBack?: boolean; appliedCount?: number;
      results?: { sql: string; ok: boolean; skipped?: boolean; error?: string }[]; error?: string;
    };
    if (job.status === 'waiting_approval' || job.status === 'running' || job.status === 'pending') {
      return text({ status: job.status, jobId: job.id, message: '사용자가 ERD 앱에서 실행을 승인하기를 기다리고 있습니다. 잠시 뒤 db_job_result로 결과를 확인하세요.' });
    }
    if (r.error && !r.results) {
      // 비교 단계(DB 읽기)에서 실패
      return { ...text({ ...connectFailure(r.error, 'connect'), stage: 'DB 읽기·비교' }), isError: true };
    }
    const failed = (r.results ?? []).filter((x) => !x.ok && !x.skipped);
    if (!failed.length) return text(r);
    const { schema } = await api.request<{ schema: Schema }>('GET', `/api/projects/${projectId}`);
    return {
      ...text({
        ...r,
        failedStatements: failed.map((x) => ({ sql: x.sql, error: x.error, diagnosis: diagnoseDbError(x.error ?? '', 'execute') })),
        relatedTables: relatedSchema(schema, failed.map((x) => `${x.sql}\n${x.error ?? ''}`).join('\n')),
        guide: [
          r.rolledBack ? 'DB는 실행 전 상태로 되돌려졌습니다.' : r.appliedCount ? `앞의 ${r.appliedCount}문장은 DB에 반영된 채 멈췄습니다 (다시 실행하면 남은 변경만 나옴).` : '',
          'diagnosis.actor가 ai면 ERD를 고쳐(edit_schema) 다시 db_push 하세요. user면(데이터 정리·확장 설치·권한 등) 사용자에게 무엇을 해야 하는지 알려 주세요. 고친 것과 남은 것을 사용자에게 보고합니다.',
        ].filter(Boolean).join(' '),
      }),
      isError: true,
    };
  };

  server.registerTool(
    'db_push',
    {
      title: 'ERD를 DB에 반영 (DB로 내보내기)',
      description: [
        'ERD와 DB를 비교해 바뀐 부분만 SQL(CREATE/ALTER/INDEX/FK)로 DB에 실행한다. 사용자의 ERD 앱이 DB에 접속해 화면의 "DB로 내보내기"와 같은 순서로 처리한다 (앱이 켜져 있어야 함).',
        'DB 실행은 되돌리기 어려워 프로젝트 AI 모드(바로 적용·제안)와 상관없이 항상 사용자가 앱에서 SQL을 보고 승인해야 실행한다 (승인을 기다리면 jobId를 주니 db_job_result로 확인).',
        '실행 전 안전 검사(NULL·중복·긴 값 등 지금 데이터로 실패할 변경)가 걸리면 실행하지 않고 findings를 돌려준다. 테이블·타입 삭제(DROP)는 include_drop=true일 때만 넣는다.',
        '실패하면 실패한 SQL마다 원인·조치·누가 고칠지(diagnosis)와 관련 테이블 정의(relatedTables)를 돌려준다: AI가 고칠 수 있는 것은 edit_schema로 고치고 다시 db_push, 사람이 해야 하는 것은 사용자에게 알린다.',
        'dry_run=true면 실행하지 않고 실행할 SQL만 보여 준다.',
      ].join(' '),
      inputSchema: {
        project: projectArg,
        connection: z.string().optional().describe('연결 id 또는 이름 (생략하면 프로젝트에 연결된 DB)'),
        include_drop: z.boolean().optional().describe('테이블·타입 삭제(DROP)도 실행 (기본 false)'),
        dry_run: z.boolean().optional(),
      },
      annotations: { destructiveHint: true },
    },
    safe(async (a: { project: string; connection?: string; include_drop?: boolean; dry_run?: boolean }) => {
      const p = await resolveProject(a.project);
      // 실행은 항상 사람이 앱에서 승인 (AI 모드와 상관없이)
      const job = await viaApp('push', { ref: a.connection, includeDrop: Boolean(a.include_drop), dryRun: Boolean(a.dry_run) }, p.id, 100);
      return pushReport(p.id, job);
    }),
  );

  server.registerTool(
    'db_job_result',
    {
      title: 'DB 작업 결과 확인',
      description: '승인을 기다리던 db_push 등 DB 작업의 결과를 확인한다 (최대 100초 기다림).',
      inputSchema: { job: z.string().describe('jobId') },
      annotations: { readOnlyHint: true },
    },
    safe(async (a: { job: string }) => {
      const job = await api.request<JobResult>('GET', `/api/db-jobs/${encodeURIComponent(a.job)}?wait=100`);
      if (job.status === 'failed' && !job.result) return { ...text({ ...job, ...(job.error ? { diagnosis: diagnoseDbError(job.error, 'execute') } : {}) }), isError: true };
      if (job.projectId) return pushReport(job.projectId, job);
      return text(job.status === 'done' ? job.result : job);
    }),
  );

  server.registerTool(
    'compare_databases',
    {
      title: 'DB끼리 비교 (개발 ↔ 운영)',
      description: [
        '두 DB 연결(예: 개발·운영)의 구조(테이블·컬럼·인덱스·외래키·뷰·함수 등)를 읽어 차이를 돌려준다. 사용자의 ERD 앱이 PC에서 두 DB를 읽기만 한다 (앱이 켜져 있어야 함).',
        'source(기준)에만 있는 것 onlyInSource, 다른 것 different, target(대상)에만 있는 것 onlyInTarget, 그리고 대상을 기준과 같게 만드는 SQL(statements)을 준다.',
        'SQL은 실행하지 않는다. 사용자에게 차이를 쉬운 말로 요약하고(배포 누락·운영에만 있는 인덱스 등), 운영 반영은 사람이 검토하도록 안내한다. DROP은 include_drop=true일 때만 SQL에 넣는다.',
      ].join(' '),
      inputSchema: {
        source: z.string().describe('기준 연결 id 또는 이름 (예: 개발 DB)'),
        target: z.string().describe('대상 연결 id 또는 이름 (예: 운영 DB)'),
        include_drop: z.boolean().optional().describe('대상에만 있는 테이블의 DROP도 SQL에 넣기 (기본 false)'),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async (a: { source: string; target: string; include_drop?: boolean }) => {
      const job = await viaApp('compare', { source: a.source, target: a.target, includeDrop: Boolean(a.include_drop) }, undefined, 100);
      const r = job.result ?? {};
      if (r.ok === false) return { ...text({ ...connectFailure(String(r.error)), stage: 'DB 읽기' }), isError: true };
      return text(r);
    }),
  );

  server.registerTool(
    'generate_test_data',
    {
      title: '테스트 데이터 만들기 (INSERT)',
      description: [
        'ERD를 보고 외래키·NOT NULL·UNIQUE·ENUM·간단한 CHECK를 지키는 가짜 데이터를 INSERT SQL로 만든다. 부모 테이블부터 채우고 이름·연락처·이메일·금액처럼 컬럼 이름에 맞는 값을 넣는다.',
        'insert=false(기본)면 SQL만 돌려준다. insert=true면 사용자의 ERD 앱이 연결한 DB에 넣는데, AI 모드와 상관없이 사용자가 앱에서 승인해야 실행된다 (승인을 기다리면 jobId → db_job_result).',
        '개발·테스트 DB에만 넣는다 — 운영 DB로 보이는 연결이면 넣지 말고 사용자에게 확인한다. DB에 이미 데이터가 있으면 start_id를 크게 해 기본키가 겹치지 않게 한다.',
      ].join(' '),
      inputSchema: {
        project: projectArg,
        rows: z.number().int().min(1).max(10000).optional().describe('테이블마다 행 수 (기본 20)'),
        tables: z.array(z.string()).optional().describe('이 테이블만 (NOT NULL 외래키의 부모는 자동으로 함께). 생략하면 전체'),
        start_id: z.number().int().min(0).optional().describe('정수 기본키 시작 번호 (기본 1)'),
        seed: z.number().int().optional().describe('같은 seed면 같은 데이터 (기본 1). 다른 값을 원하면 바꾼다'),
        insert: z.boolean().optional().describe('true면 DB에 넣는다 (사용자 승인 후)'),
        connection: z.string().optional().describe('넣을 연결 id 또는 이름 (생략하면 프로젝트에 연결된 DB)'),
      },
    },
    safe(async (a: { project: string; rows?: number; tables?: string[]; start_id?: number; seed?: number; insert?: boolean; connection?: string }) => {
      const p = await resolveProject(a.project);
      if (a.insert) {
        const job = await viaApp('seed', { ref: a.connection, rows: a.rows, tables: a.tables, startId: a.start_id, seed: a.seed }, p.id, 100);
        return pushReport(p.id, job);
      }
      const { schema } = await api.request<{ schema: Schema }>('GET', `/api/projects/${p.id}`);
      const tableIds = a.tables?.map((name) => {
        const t = schema.tables.find((x) => x.name.toLowerCase() === name.toLowerCase());
        if (!t) throw new Error(`테이블 "${name}"이 없습니다. 있는 테이블: ${schema.tables.map((x) => x.name).join(', ')}`);
        return t.id;
      });
      const r = generateSeedData(schema, getDialect(p.dialect as DialectId), { rows: a.rows, tableIds, startId: a.start_id, seed: a.seed });
      const script = seedScript(r);
      const LIMIT = 200_000;
      return text({
        tables: r.tables.map((t) => ({ name: t.name, rows: t.rows })),
        added: r.added.length ? r.added : undefined,
        skipped: r.skipped.length ? r.skipped : undefined,
        warnings: r.warnings.length ? r.warnings : undefined,
        sql: script.length > LIMIT ? `${script.slice(0, LIMIT)}\n-- … (너무 길어 잘랐습니다. rows를 줄이거나 tables로 나눠 다시)` : script,
      });
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
