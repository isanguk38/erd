import { lintSchema } from '@erd/core';
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

    const created = JSON.parse(textOf(await client.callTool({ name: 'create_project', arguments: { name: '쇼핑몰', dialect: 'postgresql' } })));
    // 새 프로젝트는 제안 모드가 기본이다. 이 테스트는 바로 적용 흐름을 본다 (사람이 화면에서 바꾼 것처럼)
    await erd.app.inject({ method: 'PATCH', url: `/api/projects/${created.id}`, payload: { aiMode: 'apply' } });
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

    // 설계 검사: 컬럼 논리명이 비어 있는 것을 알려주고, 고치면 사라진다
    const lint = JSON.parse(textOf(await client.callTool({ name: 'check_design', arguments: { project: '쇼핑몰' } })));
    expect(lint.summary).toContain('참고');
    expect(lint.basicChecks.map((i: { table: string; column?: string }) => `${i.table}.${i.column ?? ''}`)).toEqual(
      expect.arrayContaining(['member.member_id', 'member.email', 'orders.order_id', 'orders.member_id']),
    );
    await client.callTool({
      name: 'edit_schema',
      arguments: {
        project: '쇼핑몰',
        commands: [
          { op: 'updateColumn', table: 'member', column: 'member_id', changes: { logicalName: '회원번호' } },
          { op: 'updateColumn', table: 'member', column: 'email', changes: { logicalName: '이메일' } },
          { op: 'updateColumn', table: 'orders', column: 'order_id', changes: { logicalName: '주문번호' } },
        ],
      },
    });
    // FK 컬럼은 관계를 만들 때 부모 논리명(그때는 비어 있음)을 물려받았으므로 그것만 남는다
    const remaining = JSON.parse(textOf(await client.callTool({ name: 'check_design', arguments: { project: '쇼핑몰' } })));
    expect(remaining.summary).toBe('오류 0 · 경고 0 · 참고 1');
    expect(remaining.basicChecks[0].message).toContain('orders.member_id');

    // 사람이 화면에서 "무시"한 항목은 AI에게도 빼고 알려준다
    const pid = erd.projects.list().find((p) => p.name === '쇼핑몰')!.id;
    const [left] = lintSchema(erd.projects.schema(pid), 'postgresql');
    erd.projects.setMeta(pid, { lintIgnored: [left.id] });
    const quiet = JSON.parse(textOf(await client.callTool({ name: 'check_design', arguments: { project: '쇼핑몰' } })));
    expect(quiet.summary).toBe('오류 0 · 경고 0 · 참고 0 (사람이 무시한 항목 1개 제외 — 고치지 말 것)');
    expect(quiet.basicChecks).toEqual([]);
    erd.projects.setMeta(pid, { lintIgnored: [] });
    expect(textOf(await client.callTool({ name: 'check_design', arguments: { project: '쇼핑몰' } }))).toContain('참고 1');

    // AI 설계 검토: AI가 검토 결과를 저장 → 화면(문서 meta)에 보이고, check_design으로 다시 읽힌다
    const saved = JSON.parse(
      textOf(
        await client.callTool({
          name: 'save_design_review',
          arguments: {
            project: '쇼핑몰',
            summary: '주문에 상태·금액이 없습니다',
            items: [
              { severity: 'error', table: 'orders', message: '주문 금액 컬럼이 없습니다', suggestion: 'amount NUMERIC(12,2) NOT NULL 추가' },
              { severity: 'warning', table: 'orders', message: '주문 상태 컬럼이 없습니다' },
              { severity: 'info', message: '생성일시 컬럼을 공통으로 두면 좋습니다' },
            ],
          },
        }),
      ),
    );
    expect(saved.saved).toBe(3);
    const [amountId, statusId] = saved.items.map((i: { id: string }) => i.id);
    expect(erd.projects.meta(pid).aiReview?.items).toHaveLength(3);
    // 없는 테이블은 거절
    const badReview = await client.callTool({ name: 'save_design_review', arguments: { project: '쇼핑몰', items: [{ severity: 'error', table: 'nope', message: 'x' }] } });
    expect((badReview as ToolResult).isError).toBe(true);
    // 사람이 경고를 무시하면 AI에게 보이지 않는다
    erd.projects.setMeta(pid, { lintIgnored: [statusId] });
    let design = JSON.parse(textOf(await client.callTool({ name: 'check_design', arguments: { project: '쇼핑몰' } })));
    expect(design.aiReview.items.map((i: { id: string }) => i.id)).toEqual([amountId, expect.any(String)]);
    expect(design.summary).toContain('무시한 항목 1개');
    // AI가 고치고 해결 표시 → 열린 항목에서 빠지고 해결 기록이 남는다
    await client.callTool({ name: 'edit_schema', arguments: { project: '쇼핑몰', commands: [{ op: 'addColumn', table: 'orders', column: { name: 'amount', logicalName: '금액', type: 'NUMERIC(12,2)', nullable: false } }] } });
    const resolved = JSON.parse(textOf(await client.callTool({ name: 'resolve_design_review', arguments: { project: '쇼핑몰', ids: [amountId], resolution: 'orders.amount 추가' } })));
    expect(resolved.resolved[0]).toMatchObject({ id: amountId, status: 'resolved', resolution: 'orders.amount 추가' });
    design = JSON.parse(textOf(await client.callTool({ name: 'check_design', arguments: { project: '쇼핑몰' } })));
    expect(design.aiReview.items.map((i: { id: string }) => i.id)).not.toContain(amountId);
    // 다시 검토해 같은 경고를 또 보내도 같은 id → 사람이 무시한 기록이 이어진다
    const again = JSON.parse(textOf(await client.callTool({ name: 'save_design_review', arguments: { project: '쇼핑몰', items: [{ severity: 'warning', table: 'orders', message: '주문 상태 컬럼이 없습니다' }] } })));
    expect(again.items[0].id).toBe(statusId);
    expect(again.alreadyIgnoredByHuman).toContain('1개');
    erd.projects.setMeta(pid, { lintIgnored: [] });

    // 기능 추가: AI가 설계를 바꾸면 결과에 검토가 필요한 테이블이 붙고, 그 테이블만 범위 검토하면 다른 테이블 항목은 남는다
    const added = JSON.parse(textOf(await client.callTool({ name: 'edit_schema', arguments: { project: '쇼핑몰', commands: [
      { op: 'createTable', name: 'payment', logicalName: '결제', columns: [{ name: 'payment_id', logicalName: '결제번호', type: 'BIGINT', primaryKey: true }] },
      { op: 'addRelation', parent: 'orders', child: 'payment' },
    ] } })));
    expect(added.designReview).toContain('payment');
    expect(added.designReview).toContain('orders');
    await client.callTool({ name: 'save_design_review', arguments: { project: '쇼핑몰', items: [{ severity: 'warning', table: 'member', message: '회원 이름이 없습니다' }] } });
    const scopedReview = JSON.parse(textOf(await client.callTool({ name: 'save_design_review', arguments: { project: '쇼핑몰', tables: ['payment', 'orders'], items: [{ severity: 'error', table: 'payment', message: '결제 금액이 없습니다' }] } })));
    expect(scopedReview.stillUnreviewed).toBeUndefined();
    design = JSON.parse(textOf(await client.callTool({ name: 'check_design', arguments: { project: '쇼핑몰' } })));
    // 이전 검토에서 열린 항목은 다시 저장해도 사라지지 않는다 (해결 표시로만 닫힘)
    expect(design.aiReview.items.map((i: { message: string }) => i.message).sort()).toEqual(['결제 금액이 없습니다', '생성일시 컬럼을 공통으로 두면 좋습니다', '주문 상태 컬럼이 없습니다', '회원 이름이 없습니다']);
    expect(design.reviewNeeded).toBeUndefined();

    // 화면(서버 문서)에도 반영됨 + AI 작업으로 기록됨
    const id = erd.projects.list()[0].id;
    expect(erd.projects.meta(id).aiSession?.changeCount).toBeGreaterThan(0);

    // 잘못된 요청은 isError로 이유를 알려준다
    const bad = await client.callTool({ name: 'edit_schema', arguments: { project: '쇼핑몰', commands: [{ op: 'dropTable', table: 'nope' }] } });
    expect((bad as ToolResult).isError).toBe(true);
    expect(textOf(bad)).toContain('있는 테이블: member, orders');

    // DB 연결 만들기: 접속이 안 되면 저장하지 않고 이유를 알려준다
    const noDb = await client.callTool({
      name: 'create_connection',
      arguments: { name: '없는 DB', dialect: 'mysql', host: '127.0.0.1', port: 1, database: 'x', user: 'root', password: 'secret-pass' },
    });
    expect((noDb as ToolResult).isError).toBe(true);
    expect(textOf(noDb)).not.toContain('secret-pass');
    expect(JSON.parse(textOf(await client.callTool({ name: 'list_connections', arguments: {} })))).toEqual([]);

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
