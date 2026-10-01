// Yjs 실시간 동기화 (y-websocket과 같은 프로토콜).
// 메시지 0: 문서 동기화, 1: 참가자 상태(커서·선택)

import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import type { ProjectStore } from './projects';

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const PING_INTERVAL = 30_000;

export function createSyncServer(store: ProjectStore) {
  const wss = new WebSocketServer({ noServer: true });
  /** 문서별 접속자: 연결 → 그 연결이 관리하는 awareness client id들 */
  const rooms = new Map<string, Map<WebSocket, Set<number>>>();
  const listening = new Set<string>();

  const send = (conn: WebSocket, message: Uint8Array) => {
    if (conn.readyState === conn.OPEN) conn.send(message, (err) => err && conn.close());
  };

  /** 문서가 바뀌면(누가 바꾸든) 접속자 모두에게 보낸다 */
  const listen = (id: string) => {
    if (listening.has(id)) return;
    listening.add(id);
    const { doc, awareness } = store.load(id);
    doc.on('update', (update: Uint8Array, origin: unknown) => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      const message = encoding.toUint8Array(encoder);
      for (const conn of rooms.get(id)?.keys() ?? []) if (conn !== origin) send(conn, message);
    });
    awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      const changed = [...added, ...updated, ...removed];
      const owner = rooms.get(id)?.get(origin as WebSocket);
      if (owner) {
        added.forEach((c) => owner.add(c));
        removed.forEach((c) => owner.delete(c));
      }
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(awareness, changed));
      const message = encoding.toUint8Array(encoder);
      for (const conn of rooms.get(id)?.keys() ?? []) send(conn, message);
    });
  };

  const onConnection = (conn: WebSocket, id: string) => {
    listen(id);
    const { doc, awareness } = store.load(id);
    const room = rooms.get(id) ?? new Map<WebSocket, Set<number>>();
    rooms.set(id, room);
    room.set(conn, new Set());

    conn.binaryType = 'arraybuffer';
    conn.on('message', (data: ArrayBuffer) => {
      try {
        const decoder = decoding.createDecoder(new Uint8Array(data));
        const encoder = encoding.createEncoder();
        const type = decoding.readVarUint(decoder);
        if (type === MESSAGE_SYNC) {
          encoding.writeVarUint(encoder, MESSAGE_SYNC);
          // 화면에서 온 변경은 origin=conn (같은 사람에게 되돌려 보내지 않기 위해)
          syncProtocol.readSyncMessage(decoder, encoder, doc, conn);
          if (encoding.length(encoder) > 1) send(conn, encoding.toUint8Array(encoder));
        } else if (type === MESSAGE_AWARENESS) {
          awarenessProtocol.applyAwarenessUpdate(awareness, decoding.readVarUint8Array(decoder), conn);
        }
      } catch (e) {
        console.error('ws message error', e);
      }
    });

    let alive = true;
    conn.on('pong', () => (alive = true));
    const ping = setInterval(() => {
      if (!alive) return conn.terminate();
      alive = false;
      conn.ping();
    }, PING_INTERVAL);

    conn.on('close', () => {
      clearInterval(ping);
      const ids = room.get(conn);
      room.delete(conn);
      if (ids?.size) awarenessProtocol.removeAwarenessStates(awareness, [...ids], null);
      if (room.size === 0) store.save(id);
    });

    // 처음 접속: 서버 상태 요청(step1) + 지금 참가자 목록
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(encoder, doc);
    send(conn, encoding.toUint8Array(encoder));
    const states = awareness.getStates();
    if (states.size > 0) {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(awareness, [...states.keys()]));
      send(conn, encoding.toUint8Array(enc));
    }
  };

  /** http 서버의 upgrade 이벤트에 연결한다. 경로: /ws/<projectId> */
  const handleUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const match = (req.url ?? '').match(/^\/ws\/([a-zA-Z0-9-]+)/);
    if (!match || !store.exists(match[1])) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (conn) => onConnection(conn, match[1]));
  };

  return { handleUpgrade, rooms, close: () => wss.close() };
}

