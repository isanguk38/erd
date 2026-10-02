// 원격 MCP (Streamable HTTP). Claude 등의 커넥터에서 http(s)://<서버>/mcp 로 연결한다.
// - 로컬 모드: 공용 토큰(mcp-token)
// - 로그인 모드: 사용자가 만든 개인 액세스 토큰. AI는 그 사용자가 볼 수 있는 프로젝트만 다룬다.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createErdMcpServer, type ErdApi } from '@erd/mcp';
import type { Auth } from './auth';
import type { Storage } from './storage';

export function loadMcpToken(storage: Storage, fromEnv?: string): string {
  if (fromEnv) return fromEnv;
  const existing = storage.get('mcp-token');
  if (existing) return existing.toString('utf8').trim();
  const token = `erd_${randomBytes(24).toString('base64url')}`;
  storage.put('mcp-token', token);
  return token;
}

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** 서버 안에서 API를 직접 부른다. 받은 인증 헤더를 그대로 넘겨 같은 사용자 권한으로 동작한다. */
function inProcessApi(app: FastifyInstance, authorization: string, webUrl?: string): ErdApi {
  const call = async (method: string, url: string, payload?: unknown) => {
    const res = await app.inject({ method: method as 'GET', url, payload: payload as object | undefined, headers: { authorization } });
    if (res.statusCode >= 400) throw new Error((res.json() as { error?: string }).error ?? `요청 실패 (${res.statusCode})`);
    return res;
  };
  return {
    webUrl,
    request: async <T>(method: string, url: string, body?: unknown) => (await call(method, url, body)).json() as T,
    download: async (url: string) => {
      const buf = (await call('GET', url)).rawPayload;
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    },
  };
}

export function registerMcpRoute(app: FastifyInstance, options: { auth: Auth; localToken: string; webUrl?: string }) {
  const { auth, localToken, webUrl } = options;

  app.all('/mcp', async (req, reply) => {
    const header = req.headers.authorization ?? '';
    const given = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const ok = auth.enabled ? Boolean(given && auth.userFromToken(given)) : Boolean(given) && sameToken(given, localToken);
    if (!ok) {
      // 로그인 모드: MCP 클라이언트가 이 안내를 보고 브라우저 로그인(OAuth)을 시작한다
      if (auth.enabled) reply.header('www-authenticate', `Bearer resource_metadata="${auth.options.publicUrl}/.well-known/oauth-protected-resource"`);
      return reply.status(401).send({ error: 'MCP 로그인이 필요합니다 (브라우저 로그인 또는 Authorization: Bearer <토큰>)' });
    }
    // 요청마다 새 서버를 만드는 상태 없는(stateless) 방식
    const server = createErdMcpServer(inProcessApi(app, header, webUrl), { canWriteFiles: false });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.hijack();
    reply.raw.on('close', () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });
}
