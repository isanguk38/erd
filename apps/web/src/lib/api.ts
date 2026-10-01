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
