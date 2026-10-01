// 원격 MCP (Streamable HTTP). Claude 등의 커넥터에서 http(s)://<서버>/mcp 로 연결한다.
// 개인 액세스 토큰(Authorization: Bearer <토큰>)이 있어야 한다.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createErdMcpServer, type ErdApi } from '@erd/mcp';

export function loadMcpToken(dataDir: string, fromEnv?: string): string {
  if (fromEnv) return fromEnv;
  const path = join(dataDir, 'mcp-token');
  if (existsSync(path)) return readFileSync(path, 'utf8').trim();
  const token = `erd_${randomBytes(24).toString('base64url')}`;
  writeFileSync(path, token, { mode: 0o600 });
  return token;
}

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** 서버 안에서 API를 직접 부른다 (HTTP를 한 번 더 거치지 않음) */
function inProcessApi(app: FastifyInstance, webUrl?: string): ErdApi {
  const call = async (method: string, url: string, payload?: unknown) => {
    const res = await app.inject({ method: method as 'GET', url, payload: payload as object | undefined });
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

export function registerMcpRoute(app: FastifyInstance, token: string, webUrl?: string) {
  const api = inProcessApi(app, webUrl);

  app.all('/mcp', async (req, reply) => {
    const header = req.headers.authorization ?? '';
    const given = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!given || !sameToken(given, token)) {
      return reply.status(401).send({ error: 'MCP 토큰이 필요합니다 (Authorization: Bearer <토큰>)' });
    }
    // 요청마다 새 서버를 만드는 상태 없는(stateless) 방식
    const server = createErdMcpServer(api, { canWriteFiles: false });
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
