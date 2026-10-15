// AI(MCP) DB 작업 ↔ 사용자의 앱: 웹 서비스처럼 서버가 DB에 접속하지 않을 때 (serverDb=false)
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createErdMcpServer, httpApi } from '@erd/mcp';
import { buildApp, type ErdApp } from '../src/app';

let current: ErdApp | null = null;
afterEach(async () => {
  await current?.app.close();
  current = null;
});

type ToolResult = { content: { type: string; text: string }[]; isError?: boolean };
const textOf = (r: unknown) => (r as ToolResult).content[0].text;

async function start() {
  current = buildApp({ dataDir: mkdtempSync(join(tmpdir(), 'erd-')), mcpToken: 'test-token', serverDb: false, dbJobPickupMs: 1500 });
  await current.app.listen({ port: 0, host: '127.0.0.1' });
  const url = `http://127.0.0.1:${(current.app.server.address() as { port: number }).port}`;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createErdMcpServer(httpApi(url), { canWriteFiles: false });
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientTransport);
  const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args }) as Promise<ToolResult>;
  /** 사용자의 앱 흉내: 작업 하나를 가져가 handler 결과를 돌려준다. 가져간 작업 내용(비밀번호 포함)을 돌려준다 */
  const app = async (handler: (job: { kind: string; payload: Record<string, unknown> }) => Promise<{ status: string; result?: unknown; error?: string }>) => {
    const res = await fetch(`${url}/api/db-jobs/next?wait=10`);
    const { job } = (await res.json()) as { job: { id: string; kind: string; payload: Record<string, unknown> } | null };
    if (!job) throw new Error('작업이 오지 않았습니다');
    const out = await handler(job);
    await fetch(`${url}/api/db-jobs/${job.id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(out) });
    return job;
  };
  return { erd: current, url, call, app };
}

describe('AI DB 작업은 사용자의 앱이 처리 (웹 서비스)', () => {
  it('앱이 꺼져 있으면 알려 준다', async () => {
    const { call } = await start();
    const r = await call('list_connections', {});
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('ERD 앱이 열려 있지 않아');
  });

  it('연결 만들기: 앱이 접속해 확인하고, 실패하면 원인·누가 고칠지. 비밀번호는 앱에만 가고 서버에 남지 않는다', async () => {
    const { call, app, url } = await start();
    const [r, job] = await Promise.all([
      call('create_connection', { name: '게임 DB', dialect: 'postgresql', host: '127.0.0.1', port: 5432, database: 'game', user: 'postgres', password: 'pw-123' }),
      app(async () => ({ status: 'done', result: { ok: false, stage: 'test', error: 'password authentication failed for user "postgres"' } })),
    ]);
    expect(job.kind).toBe('saveConnection');
    expect(job.payload.password).toBe('pw-123'); // 앱은 받는다
    expect(r.isError).toBe(true);
    const body = JSON.parse(textOf(r));
    expect(body.diagnosis).toMatchObject({ actor: 'user', cause: expect.stringContaining('비밀번호') });
    expect(textOf(r)).not.toContain('pw-123');
    // 서버의 작업 기록에는 비밀번호가 없다
    const after = await (await fetch(`${url}/api/db-jobs/${(job as unknown as { id: string }).id}`)).text();
    expect(after).not.toContain('pw-123');

    const [ok] = await Promise.all([
      call('create_connection', { name: '게임 DB', dialect: 'postgresql', host: '127.0.0.1', port: 5432, database: 'game', user: 'postgres', password: 'right' }),
      app(async () => ({ status: 'done', result: { ok: true, connection: { id: 'c1', name: '게임 DB' }, serverVersion: 'PostgreSQL 16' } })),
    ]);
    expect(ok.isError).toBeFalsy();
    expect(JSON.parse(textOf(ok)).serverVersion).toBe('PostgreSQL 16');
  });

  it('DB로 내보내기: 프로젝트 AI 모드를 앱에 넘기고, 실패하면 실패한 SQL마다 원인·조치와 관련 테이블', async () => {
    const { call, app, erd } = await start();
    const project = JSON.parse(textOf(await call('create_project', { name: '게임', dialect: 'postgresql' })));
    await erd.app.inject({ method: 'PATCH', url: `/api/projects/${project.id}`, payload: { aiMode: 'apply' } });
    await call('edit_schema', { project: '게임', commands: [
      { op: 'createTable', name: 'hand_player', columns: [{ name: 'hand_player_id', type: 'BIGINT', primaryKey: true }] },
      { op: 'createTable', name: 'liar_accusation', columns: [{ name: 'liar_accusation_id', type: 'BIGINT', primaryKey: true }] },
      { op: 'addRelation', parent: 'hand_player', child: 'liar_accusation' },
    ] });
    const sql = 'ALTER TABLE liar_accusation ADD CONSTRAINT fk_liar_accusation_hand_player FOREIGN KEY (hand_player_id) REFERENCES hand_player (hand_player_id)';
    const [r, job] = await Promise.all([
      call('db_push', { project: '게임' }),
      app(async () => ({ status: 'done', result: { ok: false, executed: true, rolledBack: true, appliedCount: 0, results: [{ sql, ok: false, error: '"fk_liar_accusation_hand_player" 제약 조건이 이미 "liar_accusation" 릴레이션(relation)에서 사용되고 있습니다' }] } })),
    ]);
    expect(job.kind).toBe('push');
    expect(job.payload).toMatchObject({ mode: 'apply', includeDrop: false, dryRun: false });
    expect(r.isError).toBe(true);
    const body = JSON.parse(textOf(r));
    expect(body.failedStatements[0].diagnosis).toMatchObject({ actor: 'ai' });
    expect(body.relatedTables.tables.map((t: { name: string }) => t.name).sort()).toEqual(['hand_player', 'liar_accusation']);
    expect(body.guide).toContain('되돌려졌습니다');
  });

  it('제안 모드: 앱에서 승인을 기다리면 jobId를 주고, db_job_result로 결과를 받는다', async () => {
    const { call, url } = await start();
    await call('create_project', { name: '승인', dialect: 'postgresql' });
    // 앱이 가져가 "승인 대기"로 바꾸고, 나중에 승인 → 성공
    const appSide = (async () => {
      const { job } = (await (await fetch(`${url}/api/db-jobs/next?wait=10`)).json()) as { job: { id: string; payload: Record<string, unknown> } };
      expect(job.payload.mode).toBe('propose');
      await fetch(`${url}/api/db-jobs/${job.id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'waiting_approval' }) });
      return job.id;
    })();
    // MCP 쪽은 짧게 기다리게 서버 API로 직접 (도구는 100초까지 기다린다)
    const created = (await (await fetch(`${url}/api/db-jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'push', payload: { mode: 'propose' }, wait: 1 }) })).json()) as { id: string; status: string };
    const jobId = await appSide;
    expect(created.id).toBe(jobId);
    expect(['running', 'waiting_approval']).toContain(created.status);
    await fetch(`${url}/api/db-jobs/${jobId}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'done', result: { ok: true, executed: true, results: [{ sql: 'SELECT 1', ok: true }] } }) });
    const r = await call('db_job_result', { job: jobId });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(textOf(r))).toMatchObject({ ok: true, executed: true });
  });

  it('앱이 기다리다 끊기면(새로고침·창 닫기) 그 요청에 작업을 넘기지 않고, 다시 연 앱이 가져간다', async () => {
    const { url } = await start();
    const gone = new AbortController();
    const dead = fetch(`${url}/api/db-jobs/next?wait=20`, { signal: gone.signal }).catch(() => null);
    await new Promise((r) => setTimeout(r, 200));
    gone.abort(); // 새로고침
    await dead;
    await new Promise((r) => setTimeout(r, 200));
    const created = fetch(`${url}/api/db-jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'listConnections', payload: {}, wait: 5 }) }).then((r) => r.json());
    // 다시 연 앱이 가져가 처리
    const { job } = (await (await fetch(`${url}/api/db-jobs/next?wait=5`)).json()) as { job: { id: string } | null };
    expect(job).not.toBe(null);
    await fetch(`${url}/api/db-jobs/${job!.id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'done', result: { connections: [] } }) });
    expect(await created).toMatchObject({ status: 'done', result: { connections: [] } });
  });
});
