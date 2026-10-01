// DB 접속 정보 저장소. 비밀번호는 AES-256-GCM으로 암호화해 파일에 저장하고, 화면에는 돌려주지 않는다.

import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
  createdAt: string;
  updatedAt: string;
}

/** 화면에 돌려주는 형태 (비밀번호 없음) */
export type PublicConnection = Omit<SavedConnection, 'passwordEnc'> & { hasPassword: boolean };

export type ConnectionInput = Omit<SavedConnection, 'id' | 'passwordEnc' | 'createdAt' | 'updatedAt'> & { password?: string };

export class ConnectionStore {
  private readonly file: string;
  private readonly key: Buffer;

  constructor(dataDir: string, secret?: string) {
    mkdirSync(dataDir, { recursive: true });
    this.file = join(dataDir, 'connections.json');
    this.key = createHash('sha256').update(secret || this.loadOrCreateSecret(dataDir)).digest();
  }

  private loadOrCreateSecret(dataDir: string): string {
    const path = join(dataDir, 'secret.key');
    if (existsSync(path)) return readFileSync(path, 'utf8').trim();
    const secret = randomBytes(32).toString('base64');
    writeFileSync(path, secret, { mode: 0o600 });
    return secret;
  }

  private read(): SavedConnection[] {
    if (!existsSync(this.file)) return [];
    return JSON.parse(readFileSync(this.file, 'utf8')) as SavedConnection[];
  }

  private write(list: SavedConnection[]): void {
    writeFileSync(this.file, JSON.stringify(list, null, 2), { mode: 0o600 });
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

  static toPublic({ passwordEnc, ...rest }: SavedConnection): PublicConnection {
    return { ...rest, hasPassword: Boolean(passwordEnc) };
  }

  list(): PublicConnection[] {
    return this.read().map(ConnectionStore.toPublic);
  }

  get(id: string): SavedConnection {
    const found = this.read().find((c) => c.id === id);
    if (!found) throw Object.assign(new Error('연결을 찾을 수 없습니다'), { statusCode: 404 });
    return found;
  }

  create(input: ConnectionInput): PublicConnection {
    const now = new Date().toISOString();
    const { password, ...rest } = input;
    const saved: SavedConnection = { ...rest, id: randomUUID(), passwordEnc: password ? this.encrypt(password) : '', createdAt: now, updatedAt: now };
    this.write([...this.read(), saved]);
    return ConnectionStore.toPublic(saved);
  }

  /** password를 비워 보내면 기존 비밀번호를 유지한다 */
  update(id: string, input: ConnectionInput): PublicConnection {
    const list = this.read();
    const i = list.findIndex((c) => c.id === id);
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

  remove(id: string): void {
    this.write(this.read().filter((c) => c.id !== id));
  }

  /** 실제 접속에 쓰는 설정 (비밀번호 복호화) */
  config(id: string): ConnectionConfig {
    const c = this.get(id);
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
