import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { readSchema, writeSchema, type Command } from '@erd/core';
import { buildApp, type ErdApp } from '../src/app';

let current: ErdApp | null = null;
afterEach(async () => {
  await current?.app.close();
  current = null;
});

function setup() {
  current = buildApp({ dataDir: mkdtempSync(join(tmpdir(), 'erd-')) });
  return current;
}

const member: Command = {
  op: 'createTable',
  name: 'member',
  columns: [
    { name: 'member_id', type: 'BIGINT', primaryKey: true, autoIncrement: true },
    { name: 'email', type: 'VARCHAR(100)', nullable: false },
  ],
};

/** aiMode: 새 프로젝트 기본은 제안 모드. 바로 적용 흐름을 보는 테스트는 'apply'로 바꾼다 (사람이 화면에서 바꾸는 것처럼) */
async function createProject(app: ErdApp['app'], aiMode?: 'apply' | 'propose') {
  const project = (await app.inject({ method: 'POST', url: '/api/projects', payload: { name: '쇼핑몰', dialect: 'mysql' } })).json() as { id: string };
  if (aiMode) await app.inject({ method: 'PATCH', url: `/api/projects/${project.id}`, payload: { aiMode } });
  return project;
}

describe('AI 바로 적용 + 되돌리기', () => {
  it('새 프로젝트는 제안 모드가 기본: AI 변경은 승인 전까지 ERD에 반영되지 않는다', async () => {
    const { app } = setup();
    const { id } = await createProject(app);
    expect((await app.inject({ method: 'GET', url: `/api/projects/${id}` })).json().meta.aiMode).toBe('propose');
    const r = (await app.inject({ method: 'POST', url: `/api/projects/${id}/commands`, payload: { source: 'ai', commands: [member] } })).json();
    expect(r.mode).toBe('propose');
    expect((await app.inject({ method: 'GET', url: `/api/projects/${id}` })).json().schema.tables).toEqual([]);
  });

  it('AI 변경 전 버전을 자동 저장하고 한 번에 되돌린다', async () => {
    const { app } = setup();
    const { id } = await createProject(app, 'apply');
    await app.inject({ method: 'POST', url: `/api/projects/${id}/commands`, payload: { commands: [member] } }); // 사람(api)이 만든 테이블

    const r1 = (await app.inject({
      method: 'POST', url: `/api/projects/${id}/commands`,
      payload: { source: 'ai', commands: [{ op: 'addColumn', table: 'member', column: { name: 'nickname', type: 'VARCHAR(30)' } }] },
    })).json();
    expect(r1.mode).toBe('apply');
    expect(r1.changes.map((c: { summary: string }) => c.summary)).toEqual(['member.nickname 컬럼 추가']);

    await app.inject({
      method: 'POST', url: `/api/projects/${id}/commands`,
      payload: { source: 'ai', commands: [{ op: 'createTable', name: 'orders', columns: [{ name: 'order_id', type: 'BIGINT', primaryKey: true }] }] },
    });

    let project = (await app.inject({ method: 'GET', url: `/api/projects/${id}` })).json();
    expect(project.meta.aiSession.changeCount).toBe(2);
    expect(project.schema.tables.map((t: { name: string }) => t.name)).toEqual(['member', 'orders']);
    // 두 번의 AI 호출이 한 작업으로 묶여 버전은 하나만 생긴다
    const versions = (await app.inject({ method: 'GET', url: `/api/projects/${id}/versions` })).json();
    expect(versions.filter((v: { name: string }) => v.name.startsWith('AI 작업 전'))).toHaveLength(1);

    // 화면의 AI 배너: 묶음 전체 되돌리기
    await app.inject({ method: 'POST', url: `/api/projects/${id}/ai/undo`, payload: { scope: 'session' } });
    project = (await app.inject({ method: 'GET', url: `/api/projects/${id}` })).json();
    expect(project.meta.aiSession).toBe(null);
    expect(project.schema.tables.map((t: { name: string }) => t.name)).toEqual(['member']);
    expect(project.schema.tables[0].columns.map((c: { name: string }) => c.name)).toEqual(['member_id', 'email']);
  });

  it('MCP 되돌리기는 가장 최근 AI 작업 한 번만, 그 뒤 사람이 고친 것은 남긴다', async () => {
    const { app } = setup();
    const { id } = await createProject(app, 'apply');
    const run = (source: string, commands: Command[]) => app.inject({ method: 'POST', url: `/api/projects/${id}/commands`, payload: { source, commands } });
    const tables = async () => (await app.inject({ method: 'GET', url: `/api/projects/${id}` })).json().schema.tables as { name: string; columns: { name: string }[] }[];
    await run('ai', [member]);
    await run('ai', [{ op: 'createTable', name: 'orders', columns: [{ name: 'order_id', type: 'BIGINT', primaryKey: true }] }]);
    await run('api', [{ op: 'addColumn', table: 'member', column: { name: 'phone', type: 'VARCHAR(20)' } }]); // 사람이 고침

    const undo1 = (await app.inject({ method: 'POST', url: `/api/projects/${id}/ai/undo` })).json();
    expect(undo1.undone.map((c: { summary: string }) => c.summary)).toEqual(['orders 테이블 삭제']);
    let t = await tables();
    expect(t.map((x) => x.name)).toEqual(['member']);
    expect(t[0].columns.map((c) => c.name)).toContain('phone'); // 사람 편집은 그대로

    await app.inject({ method: 'POST', url: `/api/projects/${id}/ai/undo` }); // 한 단계 더
    t = await tables();
    expect(t).toEqual([]);
    const none = await app.inject({ method: 'POST', url: `/api/projects/${id}/ai/undo` });
    expect(none.statusCode).toBe(400);
  });

  it('제안 모드 프로젝트에서는 AI가 apply를 요청해도 제안으로 받는다', async () => {
    const { app } = setup();
    const { id } = await createProject(app);
    await app.inject({ method: 'PATCH', url: `/api/projects/${id}`, payload: { aiMode: 'propose' } });
    const r = (await app.inject({ method: 'POST', url: `/api/projects/${id}/commands`, payload: { source: 'ai', mode: 'apply', commands: [member] } })).json();
    expect(r.mode).toBe('propose');
    const project = (await app.inject({ method: 'GET', url: `/api/projects/${id}` })).json();
    expect(project.schema.tables).toEqual([]);
    // 사람(api)은 그대로 바로 적용
    const human = (await app.inject({ method: 'POST', url: `/api/projects/${id}/commands`, payload: { commands: [member] } })).json();
    expect(human.mode).toBe('apply');
  });

  it('인덱스 추가 결과 문구에 방식·조건이 보인다', async () => {
    const { app } = setup();
    const { id } = await createProject(app);
    const r = (await app.inject({
      method: 'POST', url: `/api/projects/${id}/commands`,
      payload: { source: 'ai', commands: [member, { op: 'addIndex', table: 'member', columns: ['email'], method: 'gin', where: 'email IS NOT NULL' }] },
    })).json();
    expect(r.messages[1]).toBe('member 인덱스 추가 (gin email WHERE email IS NOT NULL)');
  });

  it('잘못된 명령은 아무것도 바꾸지 않고 이유를 돌려준다', async () => {
    const { app } = setup();
    const { id } = await createProject(app);
    const res = await app.inject({ method: 'POST', url: `/api/projects/${id}/commands`, payload: { source: 'ai', commands: [member, { op: 'dropTable', table: 'nope' }] } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('2번째 명령 실패');
    expect((await app.inject({ method: 'GET', url: `/api/projects/${id}` })).json().schema.tables).toEqual([]);
  });
});

describe('AI 제안 모드', () => {
  it('여러 번의 제안이 하나로 모이고, 고른 변경만 반영된다', async () => {
    const { app } = setup();
    const { id } = await createProject(app);
    await app.inject({ method: 'POST', url: `/api/projects/${id}/commands`, payload: { commands: [member] } });
    await app.inject({ method: 'PATCH', url: `/api/projects/${id}`, payload: { aiMode: 'propose' } });

    const r1 = (await app.inject({
      method: 'POST', url: `/api/projects/${id}/commands`,
      payload: { source: 'ai', commands: [{ op: 'addColumn', table: 'member', column: { name: 'nickname', type: 'VARCHAR(30)' } }] },
    })).json();
    expect(r1.mode).toBe('propose');
    const r2 = (await app.inject({
      method: 'POST', url: `/api/projects/${id}/commands`,
      payload: { source: 'ai', commands: [{ op: 'addIndex', table: 'member', columns: ['nickname'], unique: true }] },
    })).json();
    expect(r2.proposalId).toBe(r1.proposalId);
    expect(r2.pendingChanges.map((c: { summary: string }) => c.summary)).toEqual(['member.nickname 컬럼 추가', 'member 인덱스 생성 (UNIQUE nickname)']);

    // 아직 ERD는 그대로
    let project = (await app.inject({ method: 'GET', url: `/api/projects/${id}` })).json();
    expect(project.schema.tables[0].columns).toHaveLength(2);
    expect(project.meta.pendingProposals).toBe(1);

    // 그 사이 사람이 다른 컬럼을 추가해도
    await app.inject({ method: 'POST', url: `/api/projects/${id}/commands`, payload: { commands: [{ op: 'addColumn', table: 'member', column: { name: 'phone', type: 'VARCHAR(20)' } }] } });

    // 컬럼 추가만 승인
    const columnChange = r2.pendingChanges[0].id;
    await app.inject({ method: 'POST', url: `/api/projects/${id}/proposals/${r1.proposalId}/apply`, payload: { selected: [columnChange] } });
    project = (await app.inject({ method: 'GET', url: `/api/projects/${id}` })).json();
    expect(project.schema.tables[0].columns.map((c: { name: string }) => c.name)).toEqual(['member_id', 'email', 'nickname', 'phone']); // 제안한 위치(email 뒤)에 들어간다
    expect(project.schema.tables[0].indexes).toEqual([]);
    expect(project.meta.pendingProposals).toBe(0);
  });
});

describe('버전', () => {
  it('화면이 보낸 스키마를 그대로 저장한다 (동기화보다 먼저 도착해도 안전)', async () => {
    const { app } = setup();
    const { id } = await createProject(app);
    const schema = { tables: [{ id: 't1', name: 'member', logicalName: '', comment: '', columns: [], indexes: [], position: { x: 0, y: 0 } }], relations: [] };
    // 서버 문서는 아직 비어 있지만, 화면이 보낸 스키마로 저장된다
    const v = (await app.inject({ method: 'POST', url: `/api/projects/${id}/versions`, payload: { name: 'DB 가져오기', source: 'db', schema } })).json();
    expect(v.tableCount).toBe(1);
    await app.inject({ method: 'POST', url: `/api/projects/${id}/versions/${v.id}/restore` });
    expect((await app.inject({ method: 'GET', url: `/api/projects/${id}` })).json().schema.tables.map((t: { name: string }) => t.name)).toEqual(['member']);
  });
});

describe('실시간 동기화', () => {
  it('API(AI) 변경이 접속한 화면에 바로 반영되고, 화면 변경도 서버에 반영된다', async () => {
    const erd = setup();
    const { id } = await createProject(erd.app, 'apply');
    await erd.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (erd.app.server.address() as { port: number }).port;

    const doc = new Y.Doc();
    const provider = new WebsocketProvider(`ws://127.0.0.1:${port}/ws`, id, doc, { WebSocketPolyfill: WebSocket as never });
    await new Promise<void>((resolve) => provider.on('sync', (synced: boolean) => synced && resolve()));

    await erd.app.inject({ method: 'POST', url: `/api/projects/${id}/commands`, payload: { source: 'ai', commands: [member] } });
    await waitFor(() => readSchema(doc).tables.length === 1);
    expect(readSchema(doc).tables[0].name).toBe('member');

    // 화면에서 테이블 이름 변경
    const edited = readSchema(doc);
    edited.tables[0].logicalName = '회원';
    doc.transact(() => writeSchema(doc, edited));
    await waitFor(() => erd.projects.schema(id).tables[0].logicalName === '회원');

    provider.destroy();
  });
});

async function waitFor(check: () => boolean, timeout = 3000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error('시간 초과');
    await new Promise((r) => setTimeout(r, 20));
  }
}
