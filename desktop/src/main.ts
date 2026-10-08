// ERD 설치형 앱 (Electron)
//
// - 배포한 ERD 사이트를 앱 창에 그대로 띄운다 (웹뷰). 로그인·프로젝트·동시 편집·AI는 웹과 같다.
// - DB 연결만 앱이 이 PC에서 직접 처리한다. 그래서 사내망·내 PC(localhost)의 DB에도 붙는다.
// - DB 접속 정보는 이 PC에만 저장하고, 비밀번호는 OS 보안 저장소(safeStorage)로 암호화한다. 서버로 보내지 않는다.

import { app, BrowserWindow, ipcMain, Menu, net, safeStorage, shell, type IpcMainInvokeEvent } from 'electron';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { appendFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { getConnector, validateChecks, type ConnectionConfig } from '@erd/db';
import { dialects, type DialectId } from '@erd/core';

// 마지막 안전망: DB 드라이버 등에서 처리되지 않은 예외가 나도 오류 창으로 앱을 멈추지 않고 기록만 한다.
// (DB 연결이 중간에 끊기는 것은 각 연결에서 처리하지만, 혹시 빠진 곳이 있어도 사용자가 작업을 잃지 않게)
function logCrash(kind: string, err: unknown): void {
  try {
    const line = JSON.stringify({ at: new Date().toISOString(), kind, error: err instanceof Error ? err.stack ?? err.message : String(err) });
    appendFileSync(join(app.getPath('userData'), 'error-log.jsonl'), `${line}${String.fromCharCode(10)}`);
  } catch {
    /* 기록도 못 하면 무시 */
  }
  console.error(kind, err);
}
process.on('uncaughtException', (err) => logCrash('uncaughtException', err));
process.on('unhandledRejection', (err) => logCrash('unhandledRejection', err));

const DEFAULT_SERVER = 'https://erd-hgcp.onrender.com';

// ── 설정 (서버 주소) ─────────────────────────────

interface AppConfig {
  serverUrl: string;
}

function configPath(): string {
  return join(app.getPath('userData'), 'config.json');
}

function loadConfig(): AppConfig {
  const fromEnv = process.env.ERD_DESKTOP_URL;
  let saved: Partial<AppConfig> = {};
  try {
    if (existsSync(configPath())) saved = JSON.parse(readFileSync(configPath(), 'utf8'));
  } catch {
    /* 잘못된 설정 파일은 무시 */
  }
  const config = { serverUrl: (fromEnv || saved.serverUrl || DEFAULT_SERVER).replace(/\/+$/, '') };
  if (!existsSync(configPath())) {
    mkdirSync(app.getPath('userData'), { recursive: true });
    writeFileSync(configPath(), JSON.stringify({ serverUrl: config.serverUrl }, null, 2));
  }
  return config;
}

const config = { serverUrl: DEFAULT_SERVER };
const serverOrigin = () => new URL(config.serverUrl).origin;

// ── DB 연결 저장소 (이 PC 전용) ─────────────────────────────

interface SavedConnection {
  id: string;
  name: string;
  dialect: DialectId;
  host: string;
  port: number;
  user: string;
  database: string;
  schema?: string;
  ssl?: boolean;
  /** safeStorage로 암호화한 비밀번호 (base64) */
  passwordEnc: string;
  createdAt: string;
  updatedAt: string;
}

type ConnectionInput = Omit<SavedConnection, 'id' | 'passwordEnc' | 'createdAt' | 'updatedAt'> & { password?: string };

const connectionsFile = () => join(app.getPath('userData'), 'connections.json');

function readConnections(): SavedConnection[] {
  try {
    return existsSync(connectionsFile()) ? JSON.parse(readFileSync(connectionsFile(), 'utf8')) : [];
  } catch {
    return [];
  }
}

function writeConnections(list: SavedConnection[]): void {
  mkdirSync(app.getPath('userData'), { recursive: true });
  writeFileSync(connectionsFile(), JSON.stringify(list, null, 2));
}

function encrypt(password: string): string {
  if (!password) return '';
  if (!safeStorage.isEncryptionAvailable()) throw new Error('이 PC에서 비밀번호 암호화를 사용할 수 없습니다.');
  return safeStorage.encryptString(password).toString('base64');
}

function decrypt(value: string): string {
  return value ? safeStorage.decryptString(Buffer.from(value, 'base64')) : '';
}

const toPublic = ({ passwordEnc, ...rest }: SavedConnection) => ({ ...rest, hasPassword: Boolean(passwordEnc) });

function findConnection(id: string): SavedConnection {
  const found = readConnections().find((c) => c.id === id);
  if (!found) throw new Error('연결을 찾을 수 없습니다');
  return found;
}

function toConfig(c: Omit<SavedConnection, 'id' | 'name' | 'passwordEnc' | 'createdAt' | 'updatedAt'>, password: string): ConnectionConfig {
  return { dialect: c.dialect, host: c.host, port: Number(c.port), user: c.user, password, database: c.database, schema: c.schema || undefined, ssl: Boolean(c.ssl) };
}

const DIALECTS = Object.keys(dialects) as DialectId[];

function validate(input: ConnectionInput): ConnectionInput {
  if (!DIALECTS.includes(input?.dialect)) throw new Error('DB 종류가 올바르지 않습니다');
  for (const field of ['host', 'user', 'database'] as const) {
    if (typeof input[field] !== 'string' || !input[field].trim()) throw new Error(`${field} 값이 필요합니다`);
  }
  const port = Number(input.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('포트가 올바르지 않습니다');
  return {
    name: String(input.name || `${input.database}@${input.host}`).trim(),
    dialect: input.dialect,
    host: input.host.trim(),
    port,
    user: input.user.trim(),
    database: input.database.trim(),
    schema: input.schema?.trim() || undefined,
    ssl: Boolean(input.ssl),
    password: typeof input.password === 'string' ? input.password : undefined,
  };
}

/** 자주 나는 접속 오류를 알아보기 쉬운 말로 */
function explain(e: unknown): Error {
  const err = e as { code?: string; message?: string };
  const message = err?.message ?? String(e);
  const map: Record<string, string> = {
    ECONNREFUSED: 'DB 서버에 연결할 수 없습니다. 호스트와 포트를 확인하세요.',
    ENOTFOUND: '호스트를 찾을 수 없습니다.',
    ETIMEDOUT: '연결 시간이 초과됐습니다. 방화벽이나 네트워크를 확인하세요.',
    ER_ACCESS_DENIED_ERROR: '아이디 또는 비밀번호가 맞지 않습니다.',
    '28P01': '아이디 또는 비밀번호가 맞지 않습니다.',
    ER_BAD_DB_ERROR: '데이터베이스가 없습니다.',
    '3D000': '데이터베이스가 없습니다.',
  };
  return new Error(err?.code && map[err.code] ? `${map[err.code]} (${message})` : message);
}

// ── 화면과의 통신 ─────────────────────────────

/** ERD 사이트에서 온 요청만 받는다 (다른 사이트로 이동했을 때 DB 기능을 쓰지 못하게) */
function handle<A extends unknown[], R>(channel: string, fn: (...args: A) => R | Promise<R>) {
  ipcMain.handle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
    const origin = event.senderFrame ? new URL(event.senderFrame.url).origin : '';
    if (origin !== serverOrigin()) throw new Error('허용되지 않은 화면에서 온 요청입니다');
    try {
      return await fn(...(args as A));
    } catch (e) {
      throw explain(e);
    }
  });
}

// ── 업데이트 ─────────────────────────────

/** 이 저장소의 릴리스 설치 파일만 받는다 */
const UPDATE_URL = /^https:\/\/github\.com\/isanguk38\/erd\/releases\/download\/v[\d.]+\/ERD-Setup-[\d.]+\.exe$/;

/** 새 버전 설치 파일을 내려받아 실행하고 앱을 끈다 (설치 프로그램이 이 앱을 새 버전으로 바꾼다) */
async function installUpdate(url: string): Promise<{ ok: true }> {
  if (typeof url !== 'string' || !UPDATE_URL.test(url)) throw new Error('허용되지 않은 설치 파일 주소입니다');
  const res = await net.fetch(url);
  if (!res.ok || !res.body) throw new Error(`설치 파일을 내려받지 못했습니다 (HTTP ${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  const file = join(app.getPath('temp'), basename(new URL(url).pathname));
  const out = createWriteStream(file);
  const progress = (percent: number) => BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('erd:update:progress', percent));
  let received = 0;
  let last = -1;
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (!out.write(value)) await once(out, 'drain');
      const percent = total ? Math.floor((received / total) * 100) : -1;
      if (percent !== last) progress((last = percent));
    }
  } finally {
    out.end();
    await once(out, 'close');
  }
  if (total && received !== total) throw new Error('설치 파일을 끝까지 받지 못했습니다. 다시 시도하세요');
  spawn(file, [], { detached: true, stdio: 'ignore' }).unref();
  setTimeout(() => app.quit(), 1000);
  return { ok: true };
}

function registerHandlers() {
  handle('erd:update:install', (url: string) => installUpdate(url));
  handle('erd:connections:list', () => readConnections().map(toPublic));

  handle('erd:connections:create', (input: ConnectionInput) => {
    const { password, ...rest } = validate(input);
    const now = new Date().toISOString();
    const saved: SavedConnection = { ...rest, id: randomUUID(), passwordEnc: encrypt(password ?? ''), createdAt: now, updatedAt: now };
    writeConnections([...readConnections(), saved]);
    return toPublic(saved);
  });

  handle('erd:connections:update', (id: string, input: ConnectionInput) => {
    const list = readConnections();
    const i = list.findIndex((c) => c.id === id);
    if (i < 0) throw new Error('연결을 찾을 수 없습니다');
    const { password, ...rest } = validate(input);
    list[i] = { ...list[i], ...rest, passwordEnc: password ? encrypt(password) : list[i].passwordEnc, updatedAt: new Date().toISOString() };
    writeConnections(list);
    return toPublic(list[i]);
  });

  handle('erd:connections:delete', (id: string) => {
    writeConnections(readConnections().filter((c) => c.id !== id));
    return { ok: true };
  });

  handle('erd:connections:test', (input: ConnectionInput & { id?: string }) => {
    const valid = validate(input);
    const password = valid.password || (input.id ? decrypt(findConnection(input.id).passwordEnc) : '');
    const cfg = toConfig(valid, password);
    return getConnector(cfg.dialect).test(cfg);
  });

  handle('erd:db:introspect', async (id: string, commentAs: 'logicalName' | 'comment' = 'logicalName') => {
    const c = findConnection(id);
    const cfg = toConfig(c, decrypt(c.passwordEnc));
    const result = await getConnector(cfg.dialect).introspect(cfg, { commentAs });
    return { ...result, dialect: cfg.dialect };
  });

  // DB 반영 전 안전 검사 (0.2.5부터): 검사 목록만 받아 읽기 전용으로 건수를 센다. SQL은 받지 않는다
  handle('erd:db:check', async (id: string, checks: unknown) => {
    const valid = validateChecks(checks);
    const c = findConnection(id);
    const cfg = toConfig(c, decrypt(c.passwordEnc));
    return getConnector(cfg.dialect).check(cfg, valid);
  });

  handle('erd:db:execute', async (id: string, statements: string[]) => {
    if (!Array.isArray(statements) || !statements.every((s) => typeof s === 'string' && s.trim())) throw new Error('실행할 SQL 문장 목록이 필요합니다');
    const c = findConnection(id);
    const cfg = toConfig(c, decrypt(c.passwordEnc));
    const result = await getConnector(cfg.dialect).execute(cfg, statements);
    // 무엇을 언제 실행했는지 이 PC에 기록한다
    const log = join(app.getPath('userData'), 'apply-log.jsonl');
    writeFileSync(log, JSON.stringify({ at: new Date().toISOString(), connection: c.name, database: c.database, ok: result.ok, results: result.results }) + '\n', { flag: 'a' });
    return result;
  });
}

// ── 창 ─────────────────────────────

function isAllowedNavigation(url: string): boolean {
  try {
    const u = new URL(url);
    // ERD 사이트와 GitHub 로그인 화면만 앱 안에서 연다
    return u.origin === serverOrigin() || u.hostname === 'github.com';
  } catch {
    return false;
  }
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: 'ERD',
    icon: join(__dirname, '..', 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  // 다른 사이트 링크(설치형 앱 받기, 문서 등)는 기본 브라우저로 연다
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigation(url)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });
  win.webContents.on('did-fail-load', (_e, code, description, url) => {
    if (code === -3) return; // 이동 중 취소
    const html = `<meta charset="utf-8"><body style="font-family:sans-serif;padding:40px;color:#334155">
      <h2>ERD 서버에 연결할 수 없습니다</h2>
      <p>${description} (${url})</p>
      <p>인터넷 연결을 확인하세요. 무료 서버는 한동안 쓰지 않으면 잠들어 처음 접속에 1분 정도 걸릴 수 있습니다.</p>
      <p><a href="${config.serverUrl}">다시 시도</a></p></body>`;
    win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  });

  win.loadURL(config.serverUrl);
  return win;
}

function buildMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'ERD',
        submenu: [
          { label: '처음 화면', click: () => BrowserWindow.getFocusedWindow()?.loadURL(config.serverUrl) },
          { role: 'reload', label: '새로고침' },
          { type: 'separator' },
          { label: '설정 파일 열기 (서버 주소)', click: () => shell.openPath(configPath()) },
          { label: '데이터 폴더 열기', click: () => shell.openPath(app.getPath('userData')) },
          { type: 'separator' },
          { role: 'toggleDevTools', label: '개발자 도구' },
          { role: 'quit', label: '끝내기' },
        ],
      },
      { label: '편집', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: '보기', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    ]),
  );
}

// 테스트·여러 계정용: 데이터 폴더를 바꿀 수 있다
if (process.env.ERD_DESKTOP_DATA) app.setPath('userData', process.env.ERD_DESKTOP_DATA);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    Object.assign(config, loadConfig());
    registerHandlers();
    buildMenu();
    createWindow();
  });

  app.on('window-all-closed', () => app.quit());
}
