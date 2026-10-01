// 로컬 MCP 서버 (Claude Code, Claude Desktop, Cursor 등에서 실행)
// ERD 서버(apps/server)가 켜져 있어야 한다. 주소: ERD_SERVER_URL (기본 http://127.0.0.1:4000), 토큰: ERD_TOKEN (로그인 모드)

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createErdMcpServer, httpApi } from './index';

// 로그인 모드(배포한) 서버에 연결할 때는 ERD_TOKEN에 개인 토큰을 넣는다
const api = httpApi(process.env.ERD_SERVER_URL ?? 'http://127.0.0.1:4000', process.env.ERD_TOKEN);
const server = createErdMcpServer(api, { canWriteFiles: true });
await server.connect(new StdioServerTransport());
