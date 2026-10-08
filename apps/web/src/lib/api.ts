import type { DialectId, Dictionary, SafetyCheck, SafetyResult, Schema } from '@erd/core';
import { desktop, viaDesktop } from './desktop';

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
    if (res.status === 401 && !url.startsWith('/auth/')) {
      // 로그인이 풀렸으면 로그인 화면으로
      window.dispatchEvent(new Event('erd:unauthorized'));
    }
    throw new Error((data as { error?: string }).error ?? `요청 실패 (${res.status})`);
  }
  return data as T;
}

/**
 * DB 연결. 설치형 앱 안에서는 앱이 사용자 PC에서 직접 처리하고(window.erdDesktop),
 * 로컬 모드 웹에서는 내 PC의 ERD 서버가 처리한다.
 */
export const api = {
  listConnections: () => (desktop ? viaDesktop(() => desktop!.listConnections()) : request<Connection[]>('GET', '/api/connections')),
  createConnection: (input: ConnectionInput) =>
    desktop ? viaDesktop(() => desktop!.createConnection(input)) : request<Connection>('POST', '/api/connections', input),
  updateConnection: (id: string, input: ConnectionInput) =>
    desktop ? viaDesktop(() => desktop!.updateConnection(id, input)) : request<Connection>('PUT', `/api/connections/${id}`, input),
  deleteConnection: (id: string) =>
    desktop ? viaDesktop(() => desktop!.deleteConnection(id)) : request<{ ok: true }>('DELETE', `/api/connections/${id}`),
  testConnection: (input: ConnectionInput & { id?: string }) =>
    desktop ? viaDesktop(() => desktop!.testConnection(input)) : request<{ serverVersion: string }>('POST', '/api/connections/test', input),
  introspect: (id: string, commentAs: 'logicalName' | 'comment' = 'logicalName') =>
    desktop ? viaDesktop(() => desktop!.introspect(id, commentAs)) : request<IntrospectResult>('POST', `/api/connections/${id}/introspect`, { commentAs }),
  /** DB 반영 전 안전 검사. 이 기능이 없는 옛 설치형 앱이면 null (앱 업데이트 필요) */
  check: (id: string, checks: SafetyCheck[]): Promise<SafetyResult[] | null> =>
    desktop
      ? desktop.check
        ? viaDesktop(() => desktop!.check!(id, checks))
        : Promise.resolve(null)
      : request<{ results: SafetyResult[] }>('POST', `/api/connections/${id}/check`, { checks }).then((r) => r.results),
  execute: (id: string, statements: string[]) =>
    desktop ? viaDesktop(() => desktop!.execute(id, statements)) : request<ExecuteResult>('POST', `/api/connections/${id}/execute`, { statements }),
};

// ── 프로젝트 / 버전 / 제안 ─────────────────────────────

export interface ProjectInfo {
  id: string;
  /** 내 권한 (로그인 모드) */
  role?: 'owner' | 'editor' | 'viewer' | null;
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
  /** 그 프로젝트의 표준 용어 사전 (없으면 null) */
  dictionary: (id: string) => request<{ dictionary: Dictionary | null }>('GET', `/api/projects/${id}/dictionary`),
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

  /** 화면의 AI 배너: 이번 AI 작업 묶음 전체를 되돌린다 */
  undoAi: (id: string) => request<{ restoredVersion: string }>('POST', `/api/projects/${id}/ai/undo`, { scope: 'session' }),
  acceptAi: (id: string) => request('POST', `/api/projects/${id}/ai/accept`),
  setDbConnection: (id: string, dbConnectionId: string | null) => request('PATCH', `/api/projects/${id}`, { dbConnectionId }),
  baseline: async (id: string, connectionId: string) =>
    (await request<{ baseline: { at: string; schema: Schema } | null }>('GET', `/api/projects/${id}/db/baseline?connectionId=${encodeURIComponent(connectionId)}`)).baseline,
  /** schema: 화면이 본 DB 구조 (ERD id로 맞춘 것) */
  saveBaseline: (id: string, connectionId: string, schema: Schema) => request<{ at: string }>('POST', `/api/projects/${id}/db/baseline`, { connectionId, schema }),
  dbStatus: (id: string) => request<DbStatus>('GET', `/api/projects/${id}/db/status`),
  mcpInfo: () => request<{ authEnabled: boolean; url: string; token: string | null; serverUrl: string; mcpCommand: string[]; user: string }>('GET', '/api/mcp-info'),
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

// ── 로그인 · 공유 · 토큰 ─────────────────────────────

export type Role = 'owner' | 'editor' | 'viewer';

export interface Me {
  authEnabled: boolean;
  user: { id: string; login: string; name: string; avatarUrl?: string } | null;
  loginMethods: ('github' | 'dev')[];
  /** false면 서버가 DB에 접속하지 않는다 (배포 웹). DB 연결은 설치형 앱에서만 */
  serverDb?: boolean;
}

export interface Member {
  user: { id: string; login: string; name: string; avatarUrl?: string } | null;
  role: Role;
}

export interface ShareLink {
  token: string;
  role: 'editor' | 'viewer';
  url: string;
  createdAt: string;
}

export interface TokenInfo {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt?: string;
}

export const authApi = {
  me: () => request<Me>('GET', '/api/me'),
  devLogin: (name: string) => request<{ user: Me['user'] }>('POST', '/auth/dev', { name }),
  logout: () => request('POST', '/auth/logout'),
  join: (token: string) => request<{ projectId: string; role: Role }>('POST', `/api/join/${token}`),
  access: (projectId: string) => request<{ myRole: Role; members: Member[]; shares: ShareLink[] }>('GET', `/api/projects/${projectId}/access`),
  createShare: (projectId: string, role: 'editor' | 'viewer') => request<ShareLink>('POST', `/api/projects/${projectId}/shares`, { role }),
  removeShare: (projectId: string, token: string) => request('DELETE', `/api/projects/${projectId}/shares/${token}`),
  setMemberRole: (projectId: string, userId: string, role: 'editor' | 'viewer') => request('PATCH', `/api/projects/${projectId}/members/${userId}`, { role }),
  removeMember: (projectId: string, userId: string) => request('DELETE', `/api/projects/${projectId}/members/${userId}`),
  tokens: () => request<TokenInfo[]>('GET', '/api/tokens'),
  revokeToken: (id: string) => request('DELETE', `/api/tokens/${id}`),
  /** MCP 로그인(OAuth)으로 연결된 앱 */
  oauthGrants: () => request<{ id: string; clientName: string; createdAt: string; lastUsedAt?: string }[]>('GET', '/api/oauth/grants'),
  revokeOauthGrant: (id: string) => request('DELETE', `/api/oauth/grants/${id}`),
  project: (id: string) => request<{ role: Role }>('GET', `/api/projects/${id}`),
};

export const templateApi = {
  get: () => request<import('@erd/core').TemplateSettings>('GET', '/api/templates'),
  save: (settings: import('@erd/core').TemplateSettings) => request<import('@erd/core').TemplateSettings>('PUT', '/api/templates', settings),
};
