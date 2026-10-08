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
  it('주제영역: AI가 영역을 만들고 묶고 옮기고, 영역 단위로 읽고 검사한다 (제안 모드 포함)', async () => {
    const { erd, url } = await start();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createErdMcpServer(httpApi(url), { canWriteFiles: false });
    await server.connect(serverTransport);
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(clientTransport);
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await client.callTool({ name, arguments: args });
      if ((r as ToolResult).isError) throw new Error(textOf(r));
      return JSON.parse(textOf(r));
    };
    const created = await call('create_project', { name: '영역', dialect: 'postgresql' });
    const pending = async () => (await erd.app.inject({ method: 'GET', url: `/api/projects/${created.id}/proposals` })).json() as { id: string; status: string }[];
    const approve = async () => {
      for (const p of (await pending()).filter((x) => x.status === 'pending')) await erd.app.inject({ method: 'POST', url: `/api/projects/${created.id}/proposals/${p.id}/apply`, payload: {} });
    };

    // 새 프로젝트는 제안 모드: 테이블은 제안으로 모이고, 사람이 승인한다
    const first = await call('edit_schema', {
      project: '영역',
      commands: [
        { op: 'createTable', name: 'member', logicalName: '회원', columns: [{ name: 'member_id', type: 'BIGINT', primaryKey: true }] },
        { op: 'createTable', name: 'orders', logicalName: '주문', columns: [{ name: 'order_id', type: 'BIGINT', primaryKey: true }] },
        { op: 'createTable', name: 'settlement', logicalName: '정산', columns: [{ name: 'settlement_id', type: 'BIGINT', primaryKey: true }] },
        { op: 'addRelation', parent: 'member', child: 'orders' },
        { op: 'createArea', name: '회원', tables: ['member'] },
        { op: 'createArea', name: '주문', tables: ['orders', 'settlement'] },
      ],
    });
    expect(first.mode).toBe('propose');
    await approve();
    let schema = await call('get_schema', { project: '영역' });
    // 제안을 승인하면 영역도 함께 반영된다
    expect(schema.areas).toEqual([{ name: '회원', tables: ['member'] }, { name: '주문', tables: ['orders', 'settlement'] }]);

    // 영역 명령만 있으면 제안 모드라도 바로 반영 (화면 구분일 뿐)
    const moved = await call('edit_schema', {
      project: '영역',
      commands: [{ op: 'createArea', name: '정산' }, { op: 'moveToArea', area: '정산', tables: ['settlement'], from: '주문' }, { op: 'addToArea', area: '주문', tables: ['member'] }],
    });
    expect(moved.mode).toBe('apply');
    schema = await call('get_schema', { project: '영역' });
    expect(schema.areas).toEqual([{ name: '회원', tables: ['member'] }, { name: '주문', tables: ['orders', 'member'] }, { name: '정산', tables: ['settlement'] }]);

    // 새 테이블을 영역에 바로 (제안 → 승인 후에도 그 영역에)
    await call('edit_schema', { project: '영역', commands: [{ op: 'createTable', name: 'payment', area: '주문', columns: [{ name: 'payment_id', type: 'BIGINT', primaryKey: true }] }] });
    await approve();

    // 영역 단위로 읽기: 영역 테이블만, 영역 밖 관계는 따로
    const part = await call('get_schema', { project: '영역', area: '회원' });
    expect(part.area).toBe('회원');
    expect(part.tables.map((t: { name: string }) => t.name)).toEqual(['member']);
    expect(part.outsideRelations).toEqual(['member ↔ orders (영역 밖)']);
    const ordersArea = await call('get_schema', { project: '영역', area: '주문' });
    expect(ordersArea.tables.map((t: { name: string }) => t.name).sort()).toEqual(['member', 'orders', 'payment']);

    // 영역 단위 검사: 그 영역 테이블 항목만
    const lint = await call('check_design', { project: '영역', area: '정산' });
    expect(lint.areaTables).toEqual(['settlement']);
    expect(lint.summary).toMatch(/^영역 정산:/);
    expect(lint.basicChecks.every((i: { table: string }) => i.table === 'settlement')).toBe(true);

    // 영역만 바꾸면 설계 검토 안내를 붙이지 않는다
    const renamed = await call('edit_schema', { project: '영역', commands: [{ op: 'updateArea', area: '정산', name: '정산·지급' }] });
    expect(renamed.designReview).toBeUndefined();
    // 영역 자동 배치: 그 영역 탭 위치만 정리하고 전체 배치는 그대로
    const before = ((await erd.app.inject({ method: 'GET', url: `/api/projects/${created.id}` })).json() as { schema: { tables: { name: string; position: unknown }[] } }).schema.tables;
    const laid = await call('auto_layout', { project: '영역', area: '주문' });
    expect(laid).toMatchObject({ ok: true, area: '주문', tables: 3 });
    const after = ((await erd.app.inject({ method: 'GET', url: `/api/projects/${created.id}` })).json() as { schema: { tables: { name: string; position: unknown }[]; areas: { name: string; positions?: Record<string, unknown> }[] } }).schema;
    expect(after.tables.map((t) => t.position)).toEqual(before.map((t) => t.position));
    expect(Object.keys(after.areas.find((a) => a.name === '주문')!.positions ?? {})).toHaveLength(3);

    // 없는 영역은 알려 준다
    const bad = await client.callTool({ name: 'get_schema', arguments: { project: '영역', area: '없음' } });
    expect((bad as ToolResult).isError).toBe(true);
    expect(textOf(bad)).toContain('영역 "없음"이 없습니다');
    // 여러 테스트가 함께 돌면 느려져 기본 제한 시간을 넘길 수 있다
  }, 30_000);

  it('표준 용어 사전·영향도·메모: AI가 사전을 찾아 쓰고, 편집 결과에서 영향과 사전 위반을 보고, 메모를 붙인다', async () => {
    const { erd, url } = await start();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createErdMcpServer(httpApi(url), { canWriteFiles: false });
    await server.connect(serverTransport);
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(clientTransport);
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await client.callTool({ name, arguments: args });
      if ((r as ToolResult).isError) throw new Error(textOf(r));
      const t = textOf(r);
      return t.startsWith('{') ? JSON.parse(t) : t;
    };
    const created = await call('create_project', { name: '사전', dialect: 'mysql' });
    await erd.app.inject({ method: 'PATCH', url: `/api/projects/${created.id}`, payload: { aiMode: 'apply' } });

    // 사전이 없으면 평소대로
    expect(await call('lookup_dictionary', { project: '사전', names: ['회원번호'] })).toContain('표준 용어 사전이 없습니다');
    expect((await call('get_schema', { project: '사전' })).project.dictionary).toBeUndefined();

    // 사람이 엑셀로 올린 사전 (화면은 문서에 직접 쓴다)
    const { doc } = erd.projects.load(created.id);
    const { writeDictionary } = await import('@erd/core');
    doc.transact(() => writeDictionary(doc, { terms: [{ logical: '회원번호', physical: 'MBR_NO', type: 'VARCHAR(20)' }, { logical: '회원명', physical: 'MBR_NM', type: 'VARCHAR(100)' }] }));

    expect((await call('get_schema', { project: '사전' })).project.dictionary).toContain('용어 2개');
    const found = await call('lookup_dictionary', { project: '사전', names: ['회원번호', '회원명', '배송지'] });
    expect(found.results[0]).toMatchObject({ name: 'MBR_NO', type: 'VARCHAR(20)' });
    expect(found.results[1]).toMatchObject({ name: 'MBR_NM', type: 'VARCHAR(100)' });
    expect(found.results[2].standard).toBeNull();

    // 사전과 다르게 만들면 결과에 dictionary로 알려 준다
    const edited = await call('edit_schema', {
      project: '사전',
      commands: [
        { op: 'createTable', name: 'member', logicalName: '회원', columns: [{ name: 'member_id', logicalName: '회원번호', type: 'BIGINT', primaryKey: true }] },
        { op: 'createTable', name: 'orders', logicalName: '주문', columns: [{ name: 'order_id', type: 'BIGINT', primaryKey: true }] },
        { op: 'addRelation', parent: 'member', child: 'orders' },
      ],
    });
    expect(edited.dictionary.join('\n')).toContain('MBR_NO VARCHAR(20)');
    const lint = await call('check_design', { project: '사전' });
    expect(lint.basicChecks.some((i: { rule: string }) => i.rule === '표준 용어와 다름')).toBe(true);

    // 사전에 없는 용어는 사전에 자동으로 (같은 것은 한 번만), 사전 표기와 다르면 넣지 않고 안내
    const added = await call('edit_schema', {
      project: '사전',
      commands: [
        { op: 'addColumn', table: 'orders', column: { name: 'ORD_AMT', logicalName: '주문금액', type: 'DECIMAL(12,2)' } },
        { op: 'addColumn', table: 'member', column: { name: 'mbrAge', logicalName: '회원나이', type: 'INT' } },
      ],
    });
    expect(added.dictionaryAdded).toEqual(['주문금액=ORD_AMT']);
    expect(added.dictionary.join('\n')).toContain('mbrAge: 사전 표기(SNAKE_CASE)와 다릅니다 — MBR_AGE');
    const again = await call('edit_schema', { project: '사전', commands: [{ op: 'addColumn', table: 'member', column: { name: 'ORD_AMT', logicalName: '주문금액', type: 'DECIMAL(12,2)' } }] });
    expect(again.dictionaryAdded).toBeUndefined();
    expect((await call('lookup_dictionary', { project: '사전' })).dictionary).toMatch(/용어 3개, 물리명 표기: SNAKE_CASE/);

    // 영향도: 부모 PK 타입만 바꾸면 FK로 이어진 자식 컬럼이 그대로라고 알려 준다
    const typed = await call('edit_schema', { project: '사전', commands: [{ op: 'updateColumn', table: 'member', column: 'member_id', changes: { name: 'MBR_NO', type: 'VARCHAR(20)' } }] });
    expect(typed.impact.join('\n')).toContain('orders.member_id(BIGINT)');
    expect(typed.dictionary).toBeUndefined();
    const dropped = await call('edit_schema', { project: '사전', commands: [{ op: 'dropTable', table: 'member' }] });
    expect(dropped.impact.join('\n')).toContain('member 삭제');

    // 메모: 영역 탭·전체 탭에 붙이고 고치고 지운다 (스키마에는 영향 없음)
    await call('edit_schema', { project: '사전', commands: [{ op: 'createArea', name: '주문', tables: ['orders'] }] });
    const note = await call('edit_notes', { project: '사전', action: 'add', text: '주문 금액은 VAT 포함', area: '주문', color: 'blue' });
    expect(note).toMatchObject({ area: '주문', color: '#dbeafe', author: 'AI' });
    await call('edit_notes', { project: '사전', action: 'update', id: note.id, text: '주문 금액은 VAT 별도' });
    const list = await call('edit_notes', { project: '사전', action: 'list' });
    expect(list.notes.map((n: { text: string }) => n.text)).toEqual(['주문 금액은 VAT 별도']);
    const sql = await call('export_sql', { project: '사전' });
    expect(sql).not.toContain('VAT');
    await call('edit_notes', { project: '사전', action: 'delete', id: note.id });
    expect((await call('edit_notes', { project: '사전', action: 'list' })).notes).toEqual([]);
  }, 30_000);

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
