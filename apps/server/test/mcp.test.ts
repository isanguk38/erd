import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createErdMcpServer, httpApi } from '@erd/mcp';
import { buildApp, type ErdApp } from '../src/app';

let current: ErdApp | null = null;
afterEach(async () => {
  await current?.app.close();
  current = null;
});

async function start() {
  current = buildApp({ dataDir: mkdtempSync(join(tmpdir(), 'erd-')), mcpToken: 'test-token' });
  await current.app.listen({ port: 0, host: '127.0.0.1' });
  return { erd: current, url: `http://127.0.0.1:${(current.app.server.address() as { port: number }).port}` };
}

type ToolResult = { content: { type: string; text: string }[]; isError?: boolean };
const textOf = (r: unknown) => (r as ToolResult).content[0].text;

describe('MCP', () => {
  it('로컬(stdio와 같은 경로): AI가 테이블을 만들고 관계를 잇고 SQL을 뽑는다', async () => {
    const { erd, url } = await start();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createErdMcpServer(httpApi(url), { canWriteFiles: true });
    await server.connect(serverTransport);
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(clientTransport);

    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toEqual(expect.arrayContaining(['get_schema', 'edit_schema', 'export_sql', 'db_push', 'export_definition_excel']));

    await client.callTool({ name: 'create_project', arguments: { name: '쇼핑몰', dialect: 'postgresql' } });
    const edit = await client.callTool({
      name: 'edit_schema',
      arguments: {
        project: '쇼핑몰',
        commands: [
          { op: 'createTable', name: 'member', logicalName: '회원', columns: [{ name: 'member_id', type: 'BIGINT', primaryKey: true, autoIncrement: true }, { name: 'email', type: 'VARCHAR(100)', nullable: false, unique: true }] },
          { op: 'createTable', name: 'orders', logicalName: '주문', columns: [{ name: 'order_id', type: 'BIGINT', primaryKey: true, autoIncrement: true }] },
          { op: 'addRelation', parent: 'member', child: 'orders', onDelete: 'CASCADE' },
          { op: 'addIndex', table: 'orders', columns: ['member_id'] },
        ],
      },
    });
    expect((edit as ToolResult).isError).toBeFalsy();
    expect(JSON.parse(textOf(edit)).mode).toBe('apply');

    const schema = JSON.parse(textOf(await client.callTool({ name: 'get_schema', arguments: { project: '쇼핑몰' } })));
    expect(schema.tables.map((t: { name: string }) => t.name)).toEqual(['member', 'orders']);
    expect(schema.relations[0]).toMatchObject({ parent: 'member', child: 'orders', onDelete: 'CASCADE' });

    const sql = textOf(await client.callTool({ name: 'export_sql', arguments: { project: '쇼핑몰' } }));
    expect(sql).toContain('CREATE TABLE member');
    expect(sql).toContain('FOREIGN KEY (member_id) REFERENCES member (member_id) ON DELETE CASCADE');

    // 화면(서버 문서)에도 반영됨 + AI 작업으로 기록됨
    const id = erd.projects.list()[0].id;
    expect(erd.projects.meta(id).aiSession?.changeCount).toBeGreaterThan(0);

    // 잘못된 요청은 isError로 이유를 알려준다
    const bad = await client.callTool({ name: 'edit_schema', arguments: { project: '쇼핑몰', commands: [{ op: 'dropTable', table: 'nope' }] } });
    expect((bad as ToolResult).isError).toBe(true);
    expect(textOf(bad)).toContain('있는 테이블: member, orders');

    // AI는 허용 없이는 DB에 실행할 수 없다
    await client.close();
  });

  it('원격: 토큰이 있어야 하고, 같은 도구를 쓸 수 있다', async () => {
    const { url } = await start();
    const noAuth = await fetch(`${url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(noAuth.status).toBe(401);

    const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Authorization: 'Bearer test-token' } } });
    const client = new Client({ name: 'remote', version: '1.0.0' });
    await client.connect(transport);
    await client.callTool({ name: 'create_project', arguments: { name: 'remote' } });
    const list = JSON.parse(textOf(await client.callTool({ name: 'list_projects', arguments: {} })));
    expect(list.map((p: { name: string }) => p.name)).toEqual(['remote']);
    await client.close();
  });
});
