// DB 접속 정보 저장소. 비밀번호는 AES-256-GCM으로 암호화해 파일에 저장하고, 화면에는 돌려주지 않는다.

import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { getJson, putJson, type Storage } from './storage';
import type { DialectId } from '@erd/core';
import type { ConnectionConfig } from '@erd/db';

export interface SavedConnection {
  id: string;
  name: string;
  dialect: DialectId;
  host: string;
  port: number;
  user: string;
  database: string;
  schema?: string;
  ssl?: boolean;
  passwordEnc: string;
  /** 만든 사람. 다른 사람은 이 연결을 보거나 쓸 수 없다 (로컬 모드: local) */
  ownerId?: string;
  createdAt: string;
  updatedAt: string;
}

/** 화면에 돌려주는 형태 (비밀번호 없음) */
export type PublicConnection = Omit<SavedConnection, 'passwordEnc' | 'ownerId'> & { hasPassword: boolean };

export type ConnectionInput = Omit<SavedConnection, 'id' | 'passwordEnc' | 'ownerId' | 'createdAt' | 'updatedAt'> & { password?: string };

/** 예전에 만든(주인 없는) 연결은 로컬 사용자 것으로 본다 */
const ownerOf = (c: SavedConnection) => c.ownerId ?? 'local';

export class ConnectionStore {
  private readonly key: Buffer;

  /** secret: 비밀번호 암호화 키. 없으면 저장소의 secret.key를 쓰고, 그것도 없으면 만든다 (로컬 전용) */
  constructor(private readonly storage: Storage, secret?: string) {
    this.key = createHash('sha256').update(secret || this.loadOrCreateSecret()).digest();
  }

  private loadOrCreateSecret(): string {
    const existing = this.storage.get('secret.key');
    if (existing) return existing.toString('utf8').trim();
    const secret = randomBytes(32).toString('base64');
    this.storage.put('secret.key', secret);
    return secret;
  }

  private read(): SavedConnection[] {
    return getJson<SavedConnection[]>(this.storage, 'connections.json', []);
  }

  private write(list: SavedConnection[]): void {
    putJson(this.storage, 'connections.json', list);
  }

  encrypt(text: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64')).join('.');
  }

  decrypt(value: string): string {
    if (!value) return '';
    const [iv, tag, data] = value.split('.').map((p) => Buffer.from(p, 'base64'));
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  }

  static toPublic({ passwordEnc, ownerId: _owner, ...rest }: SavedConnection): PublicConnection {
    return { ...rest, hasPassword: Boolean(passwordEnc) };
  }

  list(ownerId: string): PublicConnection[] {
    return this.read().filter((c) => ownerOf(c) === ownerId).map(ConnectionStore.toPublic);
  }

  /** 다른 사람의 연결은 없는 것처럼 다룬다 */
  get(id: string, ownerId: string): SavedConnection {
    const found = this.read().find((c) => c.id === id && ownerOf(c) === ownerId);
    if (!found) throw Object.assign(new Error('연결을 찾을 수 없습니다'), { statusCode: 404 });
    return found;
  }

  create(input: ConnectionInput, ownerId: string): PublicConnection {
    const now = new Date().toISOString();
    const { password, ...rest } = input;
    const saved: SavedConnection = { ...rest, id: randomUUID(), passwordEnc: password ? this.encrypt(password) : '', ownerId, createdAt: now, updatedAt: now };
    this.write([...this.read(), saved]);
    return ConnectionStore.toPublic(saved);
  }

  /** password를 비워 보내면 기존 비밀번호를 유지한다 */
  update(id: string, input: ConnectionInput, ownerId: string): PublicConnection {
    const list = this.read();
    const i = list.findIndex((c) => c.id === id && ownerOf(c) === ownerId);
    if (i < 0) throw Object.assign(new Error('연결을 찾을 수 없습니다'), { statusCode: 404 });
    const { password, ...rest } = input;
    const updated: SavedConnection = {
      ...list[i],
      ...rest,
      passwordEnc: password ? this.encrypt(password) : list[i].passwordEnc,
      updatedAt: new Date().toISOString(),
    };
    list[i] = updated;
    this.write(list);
    return ConnectionStore.toPublic(updated);
  }

  remove(id: string, ownerId: string): void {
    this.get(id, ownerId);
    this.write(this.read().filter((c) => c.id !== id));
  }

  /** 실제 접속에 쓰는 설정 (비밀번호 복호화) */
  config(id: string, ownerId: string): ConnectionConfig {
    const c = this.get(id, ownerId);
    return toConfig(c, this.decrypt(c.passwordEnc));
  }
}

export function toConfig(c: Omit<SavedConnection, 'id' | 'passwordEnc' | 'createdAt' | 'updatedAt' | 'name'>, password: string): ConnectionConfig {
  return {
    dialect: c.dialect,
    host: c.host,
    port: Number(c.port),
    user: c.user,
    password,
    database: c.database,
    schema: c.schema || undefined,
    ssl: Boolean(c.ssl),
  };
}
