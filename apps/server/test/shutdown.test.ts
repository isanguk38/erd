import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { readSchema, writeSchema, type Schema } from '@erd/core';
import { buildApp } from '../src/app';

async function waitFor(check: () => boolean, timeout = 5000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error('시간 초과');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const table = (name: string) => ({ id: `t_${name}`, name, logicalName: '', comment: '', position: { x: 0, y: 0 }, columns: [], indexes: [] }) as Schema['tables'][number];

function addTable(doc: Y.Doc, name: string) {
  const s = readSchema(doc);
  s.tables.push(table(name));
  doc.transact(() => writeSchema(doc, s));
}

describe('서버 종료(재배포·잠들기) 직전 저장', () => {
  it('화면이 접속해 있어도 종료가 바로 끝나고, 방금 한 편집이 저장 타이머를 기다리지 않고 저장된다', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'erd-'));
    const erd = buildApp({ dataDir });
    const { id } = (await erd.app.inject({ method: 'POST', url: '/api/projects', payload: { name: '종료 테스트', dialect: 'mysql' } })).json();
    await erd.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (erd.app.server.address() as { port: number }).port;

    const doc = new Y.Doc();
    const provider = new WebsocketProvider(`ws://127.0.0.1:${port}/ws`, id, doc, { WebSocketPolyfill: WebSocket as never });
    await new Promise<void>((resolve) => provider.on('sync', (synced: boolean) => synced && resolve()));

    // 화면에서 편집 → 서버가 받은 직후(저장 대기 1초가 지나기 전) 종료
    addTable(doc, 'last_second');
    await waitFor(() => erd.projects.schema(id).tables.length === 1);

    const started = Date.now();
    await erd.app.close();
    const took = Date.now() - started;
    provider.destroy();
    expect(took).toBeLessThan(4000);

    // 종료가 끝난 바로 그 시점에 이미 저장되어 있어야 한다
    const again = buildApp({ dataDir });
    expect(again.projects.schema(id).tables.map((t) => t.name)).toEqual(['last_second']);
    await again.app.close();
  }, 15000);

  it('끊긴 사이 화면에서 한 편집은, 새 서버에 다시 접속하면 보내져 합쳐진다', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'erd-'));
    const first = buildApp({ dataDir });
    const { id } = (await first.app.inject({ method: 'POST', url: '/api/projects', payload: { name: '재접속 테스트', dialect: 'mysql' } })).json();
    await first.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (first.app.server.address() as { port: number }).port;

    const doc = new Y.Doc();
    const provider = new WebsocketProvider(`ws://127.0.0.1:${port}/ws`, id, doc, { WebSocketPolyfill: WebSocket as never, maxBackoffTime: 300 });
    await new Promise<void>((resolve) => provider.on('sync', (synced: boolean) => synced && resolve()));
    addTable(doc, 'before_restart');
    await waitFor(() => first.projects.schema(id).tables.length === 1);

    // 재배포: 옛 서버 종료 → 화면은 끊긴 상태에서 계속 편집
    await first.app.close();
    await waitFor(() => !provider.wsconnected);
    addTable(doc, 'while_offline');

    // 새 서버가 같은 주소로 뜨면 화면이 다시 접속해 끊긴 사이의 편집을 보낸다
    const second = buildApp({ dataDir });
    await second.app.listen({ port, host: '127.0.0.1' });
    await waitFor(() => second.projects.schema(id).tables.length === 2, 8000);
    expect(second.projects.schema(id).tables.map((t) => t.name).sort()).toEqual(['before_restart', 'while_offline']);
    provider.destroy();
    await second.app.close();

    // 새 서버를 끈 뒤에도 남아 있다
    const third = buildApp({ dataDir });
    expect(third.projects.schema(id).tables.map((t) => t.name).sort()).toEqual(['before_restart', 'while_offline']);
    await third.app.close();
  }, 20000);

  it('종료 중에는 새 실시간 접속을 받지 않는다 (화면은 새 서버로 다시 접속)', async () => {
    const erd = buildApp({ dataDir: mkdtempSync(join(tmpdir(), 'erd-')) });
    const { id } = (await erd.app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'x', dialect: 'mysql' } })).json();
    await erd.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (erd.app.server.address() as { port: number }).port;
    const closing = erd.sync.close();
    const res = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/${id}`);
      ws.on('unexpected-response', (_req, r) => resolve(r.statusCode ?? 0));
      ws.on('open', () => resolve(101));
      ws.on('error', () => resolve(-1));
    });
    await closing;
    await erd.app.close();
    expect(res).toBe(503);
  }, 10000);
});
