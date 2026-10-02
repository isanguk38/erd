// 쿼리 도중 DB 연결이 끊겨도 프로그램 전체가 멈추지 않고(처리되지 않은 예외 없음) 알아보기 쉬운 오류로 실패해야 한다.
// (설치형 앱에서 "A JavaScript error occurred in the main process: Connection terminated unexpectedly"가 뜨던 문제)
import { afterEach, describe, expect, it } from 'vitest';
import net from 'node:net';
import { getConnector } from '../src';

const postgresConnector = getConnector('postgresql');

/** 인증까지는 받아 주고, 첫 쿼리가 오면 연결을 끊어 버리는 가짜 PostgreSQL 서버 */
function droppingPostgres(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      let started = false;
      socket.on('data', (buf) => {
        if (!started) {
          started = true;
          // AuthenticationOk + ReadyForQuery(Idle)
          socket.write(Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0, 0x5a, 0, 0, 0, 5, 0x49]));
          return;
        }
        if (buf[0] === 0x51 /* Query */ || buf[0] === 0x50 /* Parse */) socket.destroy();
      });
      socket.on('error', () => {});
    });
    server.listen(0, '127.0.0.1', () => resolve({ port: (server.address() as net.AddressInfo).port, close: () => server.close() }));
  });
}

const uncaught: unknown[] = [];
const onUncaught = (e: unknown) => uncaught.push(e);
afterEach(() => {
  process.off('uncaughtException', onUncaught);
});

describe('DB 연결이 중간에 끊길 때', () => {
  it('PostgreSQL: 구조를 읽다 끊기면 알아보기 쉬운 오류로 실패하고, 처리되지 않은 예외가 없다', async () => {
    process.on('uncaughtException', onUncaught);
    const fake = await droppingPostgres();
    try {
      const config = { dialect: 'postgresql' as const, host: '127.0.0.1', port: fake.port, user: 'u', password: 'p', database: 'd' };
      await expect(postgresConnector.introspect(config)).rejects.toThrow(/DB 연결이 중간에 끊겼습니다/);
      await expect(postgresConnector.test(config)).rejects.toThrow(/DB 연결이 중간에 끊겼습니다/);
      await new Promise((r) => setTimeout(r, 200)); // 늦게 오는 'error' 이벤트까지 기다린다
      expect(uncaught).toEqual([]);
    } finally {
      fake.close();
    }
  });
});
