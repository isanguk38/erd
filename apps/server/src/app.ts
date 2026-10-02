import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { dialects, type DialectId } from '@erd/core';
import { getConnector, type ConnectionConfig } from '@erd/db';
import { ConnectionStore, toConfig, type ConnectionInput } from './connections';
import { ProjectStore } from './projects';
import { registerProjectRoutes } from './routes/projects';
import { registerAuthRoutes, requiredRole } from './routes/auth';
import { registerTemplateRoutes } from './routes/templates';
import { createSyncServer } from './ws';
import { loadMcpToken, registerMcpRoute } from './mcp';
import { atLeast, Auth, DESKTOP_ONLY_MESSAGE, LOCAL_USER, parseCookies, type AuthOptions, type User } from './auth';
import { FileStorage, type Storage } from './storage';

declare module 'fastify' {
  interface FastifyRequest {
    /** 요청한 사용자. 로그인이 필요한 API에서는 항상 있다 (로컬 모드는 local) */
    user: User;
  }
}

export interface AppOptions {
  /** 파일 저장 위치 (storage를 주지 않으면 이 폴더에 저장) */
  dataDir?: string;
  storage?: Storage;
  /** DB 비밀번호 암호화 키 (배포 시 필수) */
  secret?: string;
  logger?: boolean;
  /** 로컬 모드 원격 MCP 토큰. 없으면 저장소의 mcp-token을 쓰거나 만든다 */
  mcpToken?: string;
  /** 화면 주소 (MCP 응답의 링크, 로그인 콜백, 초대 링크) */
  webUrl?: string;
  /** 로그인 모드 설정. 없으면 로컬 모드 */
  auth?: Omit<AuthOptions, 'publicUrl' | 'secret'> & { secret?: string };
  /** 빌드한 화면 폴더 (배포 시 같은 서버에서 제공) */
  staticDir?: string;
  /**
   * 서버가 직접 DB에 접속하는 기능을 쓸지. 기본: 로컬 모드에서만 사용.
   * 배포(로그인) 모드에서는 끄고, DB 연결은 설치형 앱이 사용자 PC에서 처리한다.
   */
  serverDb?: boolean;
}


const DIALECTS = Object.keys(dialects) as DialectId[];
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

export interface ErdApp {
  app: FastifyInstance;
  projects: ProjectStore;
  connections: ConnectionStore;
  auth: Auth;
  storage: Storage;
  sync: ReturnType<typeof createSyncServer>;
  mcpToken: string;
}

/** 로그인이 없어도 되는 경로 */
const PUBLIC_PATHS = ['/api/health', '/api/me', '/auth/', '/mcp'];

export function buildApp(options: AppOptions): ErdApp {
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 20 * 1024 * 1024 });
  const storage = options.storage ?? new FileStorage(options.dataDir ?? 'data');
  const publicUrl = (options.webUrl ?? 'http://localhost:5173').replace(/\/$/, '');
  const auth = new Auth(storage, {
    enabled: options.auth?.enabled ?? false,
    github: options.auth?.github,
    devLogin: options.auth?.devLogin,
    allowPrivateDb: options.auth?.allowPrivateDb,
    publicUrl,
    secret: options.auth?.secret ?? options.secret ?? randomBytes(32).toString('base64'),
  });
  const store = new ConnectionStore(storage, options.secret);
  const serverDb = options.serverDb ?? !auth.enabled;
  const projects = new ProjectStore(storage);
  const mcpToken = loadMcpToken(storage, options.mcpToken);

  /** 쿠키(화면) 또는 Bearer 토큰(MCP·API)으로 사용자를 찾는다 */
  const userFrom = (headers: { cookie?: string; authorization?: string }, query?: URLSearchParams): User | null => {
    const bearer = headers.authorization?.startsWith('Bearer ') ? headers.authorization.slice(7).trim() : query?.get('token') ?? '';
    if (!auth.enabled) {
      // 로컬 모드: 내 PC에서만 열려 있으므로 누구든 local 사용자. (토큰은 원격 MCP 확인용)
      return LOCAL_USER;
    }
    if (bearer) {
      const userId = auth.userFromToken(bearer);
      return userId ? auth.user(userId) : null;
    }
    const userId = auth.verifySession(parseCookies(headers.cookie).erd_session);
    return userId ? auth.user(userId) : null;
  };

  const sync = createSyncServer(projects, (req, projectId) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const user = userFrom(req.headers, url.searchParams);
    if (!user) return null;
    const role = auth.role(projectId, user.id);
    if (!role) return null;
    return { readOnly: !atLeast(role, 'editor') };
  });
  const writeLog = (entry: object) => storage.append('apply-log.jsonl', JSON.stringify(entry));
  app.server.on('upgrade', sync.handleUpgrade);

  app.setErrorHandler((error: { statusCode?: number }, _req, reply) => {
    const status = error.statusCode && error.statusCode < 500 ? error.statusCode : 400;
    reply.status(status).send({ error: explainError(error) });
  });

  // 사용자 확인 + 프로젝트 권한 확인
  app.decorateRequest('user', null as unknown as User);
  app.addHook('onRequest', async (req: FastifyRequest, reply) => {
    const user = userFrom(req.headers);
    if (user) req.user = user;
    const path = req.url.split('?')[0];
    const isApi = path.startsWith('/api/');
    if (!user && isApi && !PUBLIC_PATHS.some((p) => path === p || path.startsWith(p))) {
      return reply.status(401).send({ error: '로그인이 필요합니다' });
    }
    if (!serverDb && path.startsWith('/api/connections')) {
      return reply.status(403).send({ error: DESKTOP_ONLY_MESSAGE, code: 'DESKTOP_ONLY' });
    }
  });
  app.addHook('preHandler', async (req, reply) => {
    const route = req.routeOptions.url ?? '';
    const id = (req.params as { id?: string })?.id;
    if (!route.startsWith('/api/projects/:id') || !id || !req.user) return;
    if (!projects.exists(id)) return reply.status(404).send({ error: '프로젝트를 찾을 수 없습니다' });
    const needed = requiredRole(req.method, route);
    const role = auth.role(id, req.user.id);
    if (!atLeast(role, needed)) {
      return reply.status(role ? 403 : 404).send({ error: role ? '이 작업을 할 권한이 없습니다' : '프로젝트를 찾을 수 없습니다' });
    }
  });

  app.get('/api/health', async () => ({ ok: true }));

  // ── DB 연결 관리 (연결은 만든 사람만 보고 쓸 수 있다) ──────────────────────────────
  app.get('/api/connections', async (req) => store.list(req.user.id));
  app.post('/api/connections', async (req) => store.create(validateInput(req.body), req.user.id));
  app.put<{ Params: { id: string } }>('/api/connections/:id', async (req) => store.update(req.params.id, validateInput(req.body), req.user.id));
  app.delete<{ Params: { id: string } }>('/api/connections/:id', async (req) => {
    store.remove(req.params.id, req.user.id);
    return { ok: true };
  });

  /** 저장 전 연결 확인. id를 주고 비밀번호를 비우면 저장된 비밀번호를 쓴다. */
  app.post<{ Body: Record<string, unknown> & { id?: string } }>('/api/connections/test', async (req) => {
    const input = validateInput(req.body);
    const password = input.password || (req.body.id ? store.decrypt(store.get(req.body.id, req.user.id).passwordEnc) : '');
    const config: ConnectionConfig = toConfig(input, password);
    await auth.assertAllowedDbHost(config.host);
    return getConnector(config.dialect).test(config);
  });

  app.post<{ Params: { id: string }; Body: { commentAs?: 'logicalName' | 'comment' } }>('/api/connections/:id/introspect', async (req) => {
    const config = store.config(req.params.id, req.user.id);
    await auth.assertAllowedDbHost(config.host);
    const result = await getConnector(config.dialect).introspect(config, { commentAs: req.body?.commentAs });
    return { ...result, dialect: config.dialect };
  });

  app.post<{ Params: { id: string }; Body: { statements: string[] } }>('/api/connections/:id/execute', async (req) => {
    const statements = req.body?.statements;
    if (!Array.isArray(statements) || !statements.every((s) => typeof s === 'string' && s.trim())) {
      throw Object.assign(new Error('실행할 SQL 문장 목록이 필요합니다'), { statusCode: 400 });
    }
    if (statements.length > MAX_STATEMENTS) throw Object.assign(new Error(`한 번에 ${MAX_STATEMENTS}개까지 실행할 수 있습니다`), { statusCode: 400 });
    const saved = store.get(req.params.id, req.user.id);
    const config = store.config(req.params.id, req.user.id);
    await auth.assertAllowedDbHost(config.host);
    const result = await getConnector(config.dialect).execute(config, statements);
    // 누가 무엇을 언제 실행했는지 기록을 남긴다
    writeLog({ at: new Date().toISOString(), user: req.user.login, connection: saved.name, database: saved.database, source: 'user', ok: result.ok, results: result.results });
    return result;
  });

  registerAuthRoutes(app, auth, projects, serverDb);
  registerTemplateRoutes(app, storage);
  registerProjectRoutes(app, projects, store, writeLog, auth, serverDb);
  registerMcpRoute(app, { auth, localToken: mcpToken, webUrl: publicUrl });

  /** 화면의 "AI 연결" 안내용 */
  app.get('/api/mcp-info', async (req) => {
    const address = app.server.address();
    const port = typeof address === 'object' && address ? address.port : 4000;
    const serverUrl = auth.enabled ? publicUrl : `http://127.0.0.1:${port}`;
    return {
      authEnabled: auth.enabled,
      serverUrl,
      url: `${serverUrl}/mcp`,
      // 로컬 모드에서만 공용 토큰을 보여준다. 로그인 모드에서는 개인 토큰을 만들어 쓴다.
      token: auth.enabled ? null : mcpToken,
      user: req.user.login,
      // 배포한 서버의 경로는 사용자 PC에 없으므로, 로그인 모드에서는 저장소를 받은 폴더 기준으로 안내한다
      mcpCommand: ['node', auth.enabled ? '<ERD 저장소 폴더>/packages/mcp/bin/erd-mcp.mjs' : fileURLToPath(new URL('../../../packages/mcp/bin/erd-mcp.mjs', import.meta.url))],
    };
  });

  // ── 배포: 빌드한 화면을 같은 서버에서 제공 ─────────────────────────────
  if (options.staticDir && existsSync(options.staticDir)) {
    // 시작 뒤에 새로 빌드한 파일도 제공하도록 요청마다 디스크에서 찾는다
    app.register(fastifyStatic, { root: options.staticDir });
    app.setNotFoundHandler((req, reply) => {
      const path = req.url.split('?')[0];
      if (req.method === 'GET' && !path.startsWith('/api/') && !path.startsWith('/auth/') && !path.startsWith('/ws/') && !path.includes('.')) {
        return reply.sendFile('index.html');
      }
      reply.status(404).send({ error: '찾을 수 없습니다' });
    });
  }

  // 종료 순서: ① 실시간 접속을 먼저 끊어 편집을 그만 받고 (preClose: HTTP 서버를 닫기 전에 해야 종료가 멈추지 않는다)
  // ② 메모리의 문서를 바로 저장 ③ 저장소 쓰기가 끝날 때까지 기다린다 (최대 20초)
  app.addHook('preClose', async () => {
    await sync.close();
  });
  app.addHook('onClose', async () => {
    projects.flush();
    await Promise.race([storage.flush(), new Promise((resolve) => setTimeout(resolve, 20_000))]);
  });

  return { app, projects, connections: store, auth, storage, sync, mcpToken };
}
