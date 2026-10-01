// 저장소. 같은 코드로 로컬 파일(개발·내 PC) 또는 PostgreSQL(배포)에 저장한다.
// Render 무료 서버처럼 재시작하면 디스크가 지워지는 곳에서는 PostgreSQL(DATABASE_URL)을 쓴다.
//
// 읽기는 동기(파일은 바로 읽고, PostgreSQL은 시작할 때 전부 메모리에 올린다),
// 쓰기는 파일은 바로, PostgreSQL은 메모리에 먼저 반영하고 뒤에서 순서대로 저장한다.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

export interface Storage {
  readonly kind: 'file' | 'postgres';
  get(key: string): Buffer | undefined;
  put(key: string, value: Buffer | string): void;
  delete(key: string): void;
  /** prefix로 시작하는 키 목록 */
  keys(prefix: string): string[];
  /** 기록용 (실행 로그 등) */
  append(key: string, line: string): void;
  /** 밀린 쓰기를 모두 저장 */
  flush(): Promise<void>;
  close(): Promise<void>;
}

export function getJson<T>(storage: Storage, key: string, fallback: T): T {
  const buf = storage.get(key);
  return buf ? (JSON.parse(buf.toString('utf8')) as T) : fallback;
}

export function putJson(storage: Storage, key: string, value: unknown): void {
  storage.put(key, JSON.stringify(value));
}

function checkKey(key: string): void {
  if (!/^[a-zA-Z0-9._/-]+$/.test(key) || key.includes('..')) throw new Error(`잘못된 저장 키: ${key}`);
}

/** 로컬 파일 저장소: 키 = dataDir 아래 상대 경로 */
export class FileStorage implements Storage {
  readonly kind = 'file' as const;
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private path(key: string): string {
    checkKey(key);
    return join(this.dir, ...key.split('/'));
  }

  get(key: string): Buffer | undefined {
    const p = this.path(key);
    return existsSync(p) ? readFileSync(p) : undefined;
  }

  put(key: string, value: Buffer | string): void {
    const p = this.path(key);
    mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, value, { mode: 0o600 });
    renameSync(tmp, p);
  }

  delete(key: string): void {
    rmSync(this.path(key), { recursive: true, force: true });
  }

  keys(prefix: string): string[] {
    const result: string[] = [];
    const walk = (dir: string) => {
      if (!existsSync(dir)) return;
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (!name.endsWith('.tmp')) result.push(relative(this.dir, full).split(sep).join('/'));
      }
    };
    walk(this.dir);
    return result.filter((k) => k.startsWith(prefix)).sort();
  }

  append(key: string, line: string): void {
    const p = this.path(key);
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, line.endsWith('\n') ? line : `${line}\n`);
  }

  async flush(): Promise<void> {}
  async close(): Promise<void> {}
}

/** pg.Pool, PGlite 등 */
export interface SqlClient {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

/**
 * PostgreSQL 저장소. 테이블 하나(erd_kv)에 키-값으로 저장한다.
 * 시작할 때 전부 읽어 메모리에 두고, 쓰기는 메모리에 바로 반영한 뒤 순서대로 DB에 저장한다.
 */
export class PostgresStorage implements Storage {
  readonly kind = 'postgres' as const;
  private readonly cache = new Map<string, Buffer>();
  private readonly pending = new Map<string, Buffer | null>();
  private readonly logs: { key: string; line: string }[] = [];
  private running: Promise<void> | null = null;

  private constructor(private readonly db: SqlClient, private readonly end?: () => Promise<void>) {}

  static async open(db: SqlClient, end?: () => Promise<void>): Promise<PostgresStorage> {
    await db.query(`CREATE TABLE IF NOT EXISTS erd_kv (key TEXT PRIMARY KEY, value BYTEA NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await db.query(`CREATE TABLE IF NOT EXISTS erd_log (id BIGSERIAL PRIMARY KEY, key TEXT NOT NULL, line TEXT NOT NULL, at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const storage = new PostgresStorage(db, end);
    const { rows } = await db.query<{ key: string; value: Buffer | Uint8Array }>('SELECT key, value FROM erd_kv');
    for (const row of rows) storage.cache.set(row.key, Buffer.from(row.value));
    return storage;
  }

  get(key: string): Buffer | undefined {
    return this.cache.get(key);
  }

  put(key: string, value: Buffer | string): void {
    checkKey(key);
    const buf = typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value);
    this.cache.set(key, buf);
    this.pending.set(key, buf);
    this.kick();
  }

  delete(key: string): void {
    for (const k of [...this.cache.keys()]) {
      if (k === key || k.startsWith(`${key}/`)) {
        this.cache.delete(k);
        this.pending.set(k, null);
      }
    }
    this.kick();
  }

  keys(prefix: string): string[] {
    return [...this.cache.keys()].filter((k) => k.startsWith(prefix)).sort();
  }

  append(key: string, line: string): void {
    this.logs.push({ key, line });
    this.kick();
  }

  /** 밀린 쓰기를 하나씩 저장한다. 실패하면 잠시 뒤 다시 시도한다. */
  private kick(): void {
    if (this.running) return;
    this.running = (async () => {
      while (this.pending.size || this.logs.length) {
        const [key, value] = this.pending.entries().next().value ?? [];
        try {
          if (key !== undefined) {
            if (value) {
              await this.db.query(
                `INSERT INTO erd_kv (key, value, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
                [key, value],
              );
            } else {
              await this.db.query('DELETE FROM erd_kv WHERE key = $1', [key]);
            }
            // 저장하는 동안 다시 바뀌지 않았을 때만 대기열에서 뺀다
            if (this.pending.get(key) === value) this.pending.delete(key);
          } else {
            const log = this.logs[0];
            await this.db.query('INSERT INTO erd_log (key, line) VALUES ($1, $2)', [log.key, log.line]);
            this.logs.shift();
          }
        } catch (e) {
          console.error('저장 실패, 다시 시도합니다:', e instanceof Error ? e.message : e);
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
    })().finally(() => {
      this.running = null;
      if (this.pending.size || this.logs.length) this.kick();
    });
  }

  async flush(): Promise<void> {
    while (this.running) await this.running;
  }

  async close(): Promise<void> {
    await this.flush();
    await this.end?.();
  }
}
