import type { DialectId, Schema } from '@erd/core';

export interface Connection {
  id: string;
  name: string;
  dialect: DialectId;
  host: string;
  port: number;
  user: string;
  database: string;
  schema?: string;
  ssl?: boolean;
  hasPassword: boolean;
}

export type ConnectionInput = Omit<Connection, 'id' | 'hasPassword'> & { password?: string };

export interface IntrospectResult {
  schema: Schema;
  dialect: DialectId;
  serverVersion: string;
  warnings: string[];
}

export interface StatementResult {
  sql: string;
  ok: boolean;
  error?: string;
  ms: number;
  skipped?: boolean;
}

export interface ExecuteResult {
  results: StatementResult[];
  ok: boolean;
  rolledBack: boolean;
  appliedCount: number;
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error('ERD 서버에 연결할 수 없습니다. npm run dev로 서버가 함께 실행 중인지 확인하세요.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 502 || res.status === 504) throw new Error('ERD 서버가 실행 중이 아닙니다. npm run dev로 서버를 함께 실행하세요.');
    throw new Error((data as { error?: string }).error ?? `요청 실패 (${res.status})`);
  }
  return data as T;
}

export const api = {
  listConnections: () => request<Connection[]>('GET', '/api/connections'),
  createConnection: (input: ConnectionInput) => request<Connection>('POST', '/api/connections', input),
  updateConnection: (id: string, input: ConnectionInput) => request<Connection>('PUT', `/api/connections/${id}`, input),
  deleteConnection: (id: string) => request<{ ok: true }>('DELETE', `/api/connections/${id}`),
  testConnection: (input: ConnectionInput & { id?: string }) => request<{ serverVersion: string }>('POST', '/api/connections/test', input),
  introspect: (id: string, commentAs: 'logicalName' | 'comment' = 'logicalName') =>
    request<IntrospectResult>('POST', `/api/connections/${id}/introspect`, { commentAs }),
  execute: (id: string, statements: string[]) => request<ExecuteResult>('POST', `/api/connections/${id}/execute`, { statements }),
};

// ── 프로젝트 / 버전 / 제안 ─────────────────────────────

export interface ProjectInfo {
  id: string;
  name: string;
  dialect: DialectId;
  tableCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface VersionInfo {
  id: string;
  name: string;
  createdAt: string;
  source: 'manual' | 'auto' | 'db' | 'ai';
  tableCount: number;
}

export interface ChangeSummary {
  id: string;
  category: 'create' | 'alter' | 'drop';
  tableName: string;
  summary: string;
  warning?: string;
}

export interface ProposalInfo {
  id: string;
  title: string;
  source: 'ai' | 'api';
  status: 'pending' | 'applied' | 'rejected';
  createdAt: string;
  updatedAt: string;
  messages: string[];
  changes: ChangeSummary[];
}

export const projectApi = {
  list: () => request<ProjectInfo[]>('GET', '/api/projects'),
  create: (body: { name: string; dialect: DialectId; schema?: Schema }) => request<ProjectInfo>('POST', '/api/projects', body),
  remove: (id: string) => request<{ ok: true }>('DELETE', `/api/projects/${id}`),
  update: (id: string, patch: { aiMode?: 'apply' | 'propose'; aiAllowDbExecute?: boolean }) => request('PATCH', `/api/projects/${id}`, patch),

  versions: (id: string) => request<VersionInfo[]>('GET', `/api/projects/${id}/versions`),
  version: (id: string, vid: string) => request<VersionInfo & { schema: Schema }>('GET', `/api/projects/${id}/versions/${vid}`),
  /** schema: 저장할 스키마 (화면이 보고 있는 그대로 저장하기 위해 함께 보낸다) */
  saveVersion: (id: string, name: string, source: VersionInfo['source'], schema: Schema) =>
    request<VersionInfo>('POST', `/api/projects/${id}/versions`, { name, source, schema }),
  deleteVersion: (id: string, vid: string) => request('DELETE', `/api/projects/${id}/versions/${vid}`),
  restoreVersion: (id: string, vid: string) => request('POST', `/api/projects/${id}/versions/${vid}/restore`),

  proposals: (id: string) => request<ProposalInfo[]>('GET', `/api/projects/${id}/proposals`),
  applyProposal: (id: string, pid: string, selected: string[]) => request('POST', `/api/projects/${id}/proposals/${pid}/apply`, { selected }),
  rejectProposal: (id: string, pid: string) => request('POST', `/api/projects/${id}/proposals/${pid}/reject`),

  undoAi: (id: string) => request<{ restoredVersion: string }>('POST', `/api/projects/${id}/ai/undo`),
  acceptAi: (id: string) => request('POST', `/api/projects/${id}/ai/accept`),
  setDbConnection: (id: string, dbConnectionId: string | null) => request('PATCH', `/api/projects/${id}`, { dbConnectionId }),
  baseline: async (id: string, connectionId: string) =>
    (await request<{ baseline: { at: string; schema: Schema } | null }>('GET', `/api/projects/${id}/db/baseline?connectionId=${encodeURIComponent(connectionId)}`)).baseline,
  /** schema: 화면이 본 DB 구조 (ERD id로 맞춘 것) */
  saveBaseline: (id: string, connectionId: string, schema: Schema) => request<{ at: string }>('POST', `/api/projects/${id}/db/baseline`, { connectionId, schema }),
  dbStatus: (id: string) => request<DbStatus>('GET', `/api/projects/${id}/db/status`),
  mcpInfo: () => request<{ url: string; token: string; serverUrl: string; mcpCommand: string[] }>('GET', '/api/mcp-info'),
};

export interface DbStatus {
  connected: boolean;
  connection?: string;
  database?: string;
  checkedAt?: string;
  baselineAt?: string | null;
  total?: number;
  db?: number;
  erd?: number;
  conflict?: number;
  unknown?: number;
  renames?: number;
}
