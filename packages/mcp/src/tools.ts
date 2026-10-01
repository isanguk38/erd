// ERD MCP 도구. AI가 ERD를 읽고, 고치고, SQL·정의서를 만들고, DB와 동기화한다.
// 모든 동작은 ERD 서버 API를 거치므로 화면을 보고 있는 사람에게 변경이 실시간으로 보인다.

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describeSchema, type Schema } from '@erd/core';

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
  comment: z.string().optional(),
});

const command = z.discriminatedUnion('op', [
  z.object({ op: z.literal('createTable'), name: z.string(), logicalName: z.string().optional(), comment: z.string().optional(), columns: z.array(columnSpec).optional() }),
  z.object({ op: z.literal('updateTable'), table: z.string(), name: z.string().optional(), logicalName: z.string().optional(), comment: z.string().optional() }),
  z.object({ op: z.literal('dropTable'), table: z.string() }),
  z.object({ op: z.literal('addColumn'), table: z.string(), column: columnSpec, after: z.string().optional().describe('이 컬럼 뒤에 추가') }),
  z.object({ op: z.literal('updateColumn'), table: z.string(), column: z.string(), changes: columnSpec.partial() }),
  z.object({ op: z.literal('dropColumn'), table: z.string(), column: z.string() }),
  z.object({ op: z.literal('addIndex'), table: z.string(), columns: z.array(z.string()).min(1), unique: z.boolean().optional(), name: z.string().optional() }),
  z.object({ op: z.literal('dropIndex'), table: z.string(), name: z.string().optional(), columns: z.array(z.string()).optional() }),
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
]);

const mode = z.enum(['apply', 'propose']).optional().describe('apply: 바로 반영(되돌리기 가능), propose: 제안으로 모아 사람이 승인. 생략하면 프로젝트 설정을 따른다');
const projectArg = z.string().describe('프로젝트 id 또는 이름');

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
      inputSchema: { name: z.string(), dialect: z.enum(['mysql', 'postgresql']).optional() },
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
      description: '프로젝트의 테이블·컬럼·인덱스·관계를 읽는다. 편집하기 전에 먼저 호출해 지금 구조를 확인한다.',
      inputSchema: { project: projectArg },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ project }: { project: string }) => {
      const p = await resolveProject(project);
      const { meta, schema } = await api.request<{ meta: Record<string, unknown>; schema: Schema }>('GET', `/api/projects/${p.id}`);
      return text({ project: { id: p.id, name: meta.name, dialect: meta.dialect, aiMode: meta.aiMode, url: link(p.id) }, ...describeSchema(schema) });
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
      ].join(' '),
      inputSchema: { project: projectArg, commands: z.array(command).min(1), mode },
    },
    safe(async ({ project, commands, mode: m }: { project: string; commands: unknown[]; mode?: string }) => {
      const p = await resolveProject(project);
      const result = await api.request('POST', `/api/projects/${p.id}/commands`, { commands, mode: m, source: 'ai', title: 'AI 제안' });
      return text(result);
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
      return text(await api.request('POST', `/api/projects/${p.id}/import-ddl`, { sql, dialect, mode: m, source: 'ai' }));
    }),
  );

  server.registerTool(
    'export_sql',
    {
      title: 'SQL 만들기',
      description: 'ERD로 SQL을 만든다. since_version을 주면 그 버전 이후 바뀐 부분만 ALTER/CREATE로 만든다 (CREATE/ALTER/DROP 구분 포함).',
      inputSchema: { project: projectArg, dialect: z.enum(['mysql', 'postgresql']).optional(), since_version: z.string().optional().describe('버전 id (list_versions로 확인)') },
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
    { title: '자동 배치', description: '관계를 보고 테이블 위치를 자동으로 정리한다.', inputSchema: { project: projectArg } },
    safe(async ({ project }: { project: string }) => {
      const p = await resolveProject(project);
      return text(await api.request('POST', `/api/projects/${p.id}/layout`));
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
      description: '이번 AI 작업으로 바로 적용한 변경을 작업 전 상태로 되돌린다. 사용자가 되돌려 달라고 할 때만 쓴다.',
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
        author: z.string().optional(),
        since_version: z.string().optional().describe('넣으면 이 버전 이후 변경 이력 시트를 추가'),
      },
    },
    safe(async (a: { project: string; output_path?: string; layout?: string; author?: string; since_version?: string }) => {
      const p = await resolveProject(a.project);
      const q = new URLSearchParams();
      if (a.layout) q.set('layout', a.layout);
      if (a.author) q.set('author', a.author);
      if (a.since_version) q.set('since', a.since_version);
      const path = `/api/projects/${p.id}/definition.xlsx?${q}`;
      if (!options.canWriteFiles) return text({ download: `${api.webUrl ?? ''}${path}` });
      const buffer = await api.download(path);
      const file = resolve(a.output_path ?? `${p.name.replace(/[\\/:*?"<>|]+/g, '_')}_테이블정의서.xlsx`);
      writeFileSync(file, Buffer.from(buffer));
      return text({ saved: file, bytes: buffer.byteLength });
    }),
  );
}

export function httpApi(baseUrl: string): ErdApi {
  const base = baseUrl.replace(/\/$/, '');
  const call = async (method: string, path: string, body?: unknown) => {
    let res: Response;
    try {
      res = await fetch(base + path, {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new Error(`ERD 서버(${base})에 연결할 수 없습니다. ERD 폴더에서 npm run dev로 서버를 실행하세요.`);
    }
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
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
