import Fastify, { type FastifyInstance } from 'fastify';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DialectId } from '@erd/core';
import { getConnector, type ConnectionConfig } from '@erd/db';
import { ConnectionStore, toConfig, type ConnectionInput } from './connections';

export interface AppOptions {
  dataDir: string;
  secret?: string;
  logger?: boolean;
}

const DIALECTS: DialectId[] = ['mysql', 'postgresql'];
const MAX_STATEMENTS = 1000;

/** 자주 나는 접속 오류를 알아보기 쉬운 말로 바꾼다 */
export function explainError(e: unknown): string {
  const err = e as { code?: string; message?: string };
  const message = err?.message ?? String(e);
  switch (err?.code) {
    case 'ECONNREFUSED': return `DB 서버에 연결할 수 없습니다. 호스트와 포트를 확인하세요. (${message})`;
    case 'ENOTFOUND': return `호스트를 찾을 수 없습니다. (${message})`;
    case 'ETIMEDOUT': return `연결 시간이 초과됐습니다. 방화벽이나 네트워크를 확인하세요. (${message})`;
    case 'ER_ACCESS_DENIED_ERROR':
    case '28P01': return `아이디 또는 비밀번호가 맞지 않습니다. (${message})`;
    case 'ER_BAD_DB_ERROR':
    case '3D000': return `데이터베이스가 없습니다. (${message})`;
    default: return message;
  }
}

function validateInput(body: unknown): ConnectionInput {
  const b = (body ?? {}) as Record<string, unknown>;
  const dialect = b.dialect as DialectId;
  if (!DIALECTS.includes(dialect)) throw Object.assign(new Error('DB 종류가 올바르지 않습니다'), { statusCode: 400 });
  for (const field of ['name', 'host', 'user', 'database'] as const) {
    if (typeof b[field] !== 'string' || !(b[field] as string).trim()) {
      throw Object.assign(new Error(`${field} 값이 필요합니다`), { statusCode: 400 });
    }
  }
  const port = Number(b.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw Object.assign(new Error('포트가 올바르지 않습니다'), { statusCode: 400 });
  return {
    name: String(b.name).trim(),
    dialect,
    host: String(b.host).trim(),
    port,
    user: String(b.user).trim(),
    database: String(b.database).trim(),
    schema: typeof b.schema === 'string' && b.schema.trim() ? b.schema.trim() : undefined,
    ssl: Boolean(b.ssl),
    password: typeof b.password === 'string' ? b.password : undefined,
  };
}

export function buildApp(options: AppOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 20 * 1024 * 1024 });
  const store = new ConnectionStore(options.dataDir, options.secret);
  const applyLog = join(options.dataDir, 'apply-log.jsonl');

  app.setErrorHandler((error: { statusCode?: number }, _req, reply) => {
    const status = error.statusCode && error.statusCode < 500 ? error.statusCode : 400;
    reply.status(status).send({ error: explainError(error) });
  });

  app.get('/api/health', async () => ({ ok: true }));

  // ── 연결 관리 ──────────────────────────────
  app.get('/api/connections', async () => store.list());
  app.post('/api/connections', async (req) => store.create(validateInput(req.body)));
  app.put<{ Params: { id: string } }>('/api/connections/:id', async (req) => store.update(req.params.id, validateInput(req.body)));
  app.delete<{ Params: { id: string } }>('/api/connections/:id', async (req) => {
    store.remove(req.params.id);
    return { ok: true };
  });

  /** 저장 전 연결 확인. id를 주고 비밀번호를 비우면 저장된 비밀번호를 쓴다. */
  app.post<{ Body: Record<string, unknown> & { id?: string } }>('/api/connections/test', async (req) => {
    const input = validateInput(req.body);
    const password = input.password || (req.body.id ? store.decrypt(store.get(req.body.id).passwordEnc) : '');
    const config: ConnectionConfig = toConfig(input, password);
    return getConnector(config.dialect).test(config);
  });

  // ── DB 읽기 / 실행 ──────────────────────────
  app.post<{ Params: { id: string }; Body: { commentAs?: 'logicalName' | 'comment' } }>('/api/connections/:id/introspect', async (req) => {
    const config = store.config(req.params.id);
    const result = await getConnector(config.dialect).introspect(config, { commentAs: req.body?.commentAs });
    return { ...result, dialect: config.dialect };
  });

  app.post<{ Params: { id: string }; Body: { statements: string[] } }>('/api/connections/:id/execute', async (req) => {
    const statements = req.body?.statements;
    if (!Array.isArray(statements) || !statements.every((s) => typeof s === 'string' && s.trim())) {
      throw Object.assign(new Error('실행할 SQL 문장 목록이 필요합니다'), { statusCode: 400 });
    }
    if (statements.length > MAX_STATEMENTS) throw Object.assign(new Error(`한 번에 ${MAX_STATEMENTS}개까지 실행할 수 있습니다`), { statusCode: 400 });
    const saved = store.get(req.params.id);
    const config = store.config(req.params.id);
    const result = await getConnector(config.dialect).execute(config, statements);
    // 무엇을 언제 실행했는지 기록을 남긴다
    appendFileSync(
      applyLog,
      JSON.stringify({ at: new Date().toISOString(), connection: saved.name, database: saved.database, ok: result.ok, results: result.results }) + '\n',
    );
    return result;
  });

  return app;
}
