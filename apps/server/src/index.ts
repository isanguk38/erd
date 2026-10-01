import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app';

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.ERD_SERVER_PORT || 4000);
// 이 서버는 DB 접속 정보를 다루므로 기본은 내 PC에서만 접속 가능하게 연다.
const host = process.env.ERD_SERVER_HOST || '127.0.0.1';

const { app, mcpToken } = buildApp({
  dataDir: process.env.ERD_DATA_DIR || resolve(here, '../data'),
  secret: process.env.ERD_SECRET,
  mcpToken: process.env.ERD_MCP_TOKEN,
  webUrl: process.env.ERD_WEB_URL || 'http://localhost:5173',
});

// 종료할 때 메모리의 문서를 저장한다
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    app.close().finally(() => process.exit(0));
  });
}

app
  .listen({ port, host })
  .then(() => {
    console.log(`ERD 서버: http://${host}:${port}`);
    console.log(`원격 MCP: http://${host}:${port}/mcp  (토큰: ${mcpToken.slice(0, 8)}… / 전체는 apps/server/data/mcp-token)`);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
