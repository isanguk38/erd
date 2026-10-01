import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerErdTools, type ErdApi, type ToolOptions } from './tools';

export { registerErdTools, httpApi, type ErdApi, type ToolOptions } from './tools';

const INSTRUCTIONS = [
  'ERD(데이터베이스 설계도) 도구입니다.',
  '작업 순서: list_projects로 프로젝트를 찾고, get_schema로 지금 구조를 확인한 뒤, edit_schema로 고칩니다.',
  'FK는 addRelation으로 만들면 자식 테이블에 FK 컬럼이 자동으로 생깁니다.',
  '테이블과 컬럼에는 한글 논리명(logicalName)도 함께 넣어 주세요.',
  'DB에 실제로 실행하는 db_push(execute=true)는 반드시 사용자에게 SQL을 보여주고 승인을 받은 뒤에만 호출합니다.',
].join('\n');

export function createErdMcpServer(api: ErdApi, options: ToolOptions): McpServer {
  const server = new McpServer({ name: 'erd', version: '0.1.0' }, { instructions: INSTRUCTIONS });
  registerErdTools(server, api, options);
  return server;
}
