// 로그인과 권한.
// - 로컬 모드(기본): 로그인 없이 내 PC 한 사람("local")이 모든 것을 한다. 서버는 127.0.0.1에서만 열린다.
// - 로그인 모드(배포): GitHub 로그인. 프로젝트마다 owner/editor/viewer 권한, 링크로 초대, 사용자별 MCP 토큰.

import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { getJson, putJson, type Storage } from './storage';

/** 배포 환경에서 서버가 DB에 접속하지 않을 때 안내 */
export const DESKTOP_ONLY_MESSAGE = 'DB 연결은 설치형 앱에서 사용할 수 있습니다. 웹 서버는 사용자의 사내망·PC에 있는 DB에 접속할 수 없어서, DB 가져오기·내보내기는 앱이 사용자 PC에서 직접 처리합니다.';

export type Role = 'owner' | 'editor' | 'viewer';
const RANK: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 };
export const atLeast = (role: Role | null, needed: Role) => role !== null && RANK[role] >= RANK[needed];

export interface User {
  id: string;
  login: string;
  name: string;
  avatarUrl?: string;
  githubId?: number;
  createdAt: string;
}

export const LOCAL_USER: User = { id: 'local', login: 'local', name: '나', createdAt: '1970-01-01T00:00:00.000Z' };

export interface AuthOptions {
  /** 로그인 모드 사용 여부 (GitHub 설정이 있거나 개발 로그인을 켜면 true) */
  enabled: boolean;
  github?: { clientId: string; clientSecret: string };
  /** 테스트·개발용 이름만으로 로그인 (운영에서는 쓰지 않는다) */
  devLogin?: boolean;
  /** 외부에서 접속하는 주소 (OAuth 콜백, 초대 링크) */
  publicUrl: string;
  /** 세션 서명 키 */
  secret: string;
  /** 로그인 모드에서 사설망·내 PC 주소의 DB 연결 허용 여부 (기본 false: 서버 내부망 공격 방지) */
  allowPrivateDb?: boolean;
}

interface TokenRecord {
  id: string;
  userId: string;
  name: string;
  /** 토큰 원문은 저장하지 않고 해시만 둔다 */
  hash: string;
  prefix: string;
  createdAt: string;
  lastUsedAt?: string;
}

export interface Share {
  token: string;
  role: Exclude<Role, 'owner'>;
  createdAt: string;
  createdBy: string;
}

export interface ProjectAccess {
  ownerId: string;
  members: Record<string, Role>;
  shares: Share[];
}

const SESSION_DAYS = 30;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export class Auth {
  constructor(private readonly storage: Storage, readonly options: AuthOptions) {}

  get enabled(): boolean {
    return this.options.enabled;
  }

  // ── 사용자 ─────────────────────────────

  user(id: string): User | null {
    if (!this.enabled && id === LOCAL_USER.id) return LOCAL_USER;
    return getJson<User | null>(this.storage, `users/${id}.json`, null);
  }

  private saveUser(user: User): User {
    putJson(this.storage, `users/${user.id}.json`, user);
    return user;
  }

  upsertGithubUser(profile: { id: number; login: string; name?: string | null; avatar_url?: string }): User {
    const existing = this.storage
      .keys('users/')
      .map((k) => getJson<User | null>(this.storage, k, null))
      .find((u) => u?.githubId === profile.id);
    return this.saveUser({
      ...(existing ?? { id: randomUUID(), createdAt: new Date().toISOString() }),
      githubId: profile.id,
      login: profile.login,
      name: profile.name || profile.login,
      avatarUrl: profile.avatar_url,
    });
  }

  devUser(name: string): User {
    const login = `dev-${name.trim().toLowerCase().replace(/[^a-z0-9가-힣_-]+/g, '-') || 'user'}`;
    const existing = this.storage
      .keys('users/')
      .map((k) => getJson<User | null>(this.storage, k, null))
      .find((u) => u?.login === login);
    return existing ?? this.saveUser({ id: randomUUID(), login, name: name.trim() || login, createdAt: new Date().toISOString() });
  }

  // ── 세션 (서명한 쿠키) ─────────────────────────────

  private sign(value: string): string {
    return createHmac('sha256', this.options.secret).update(value).digest('base64url');
  }

  createSession(userId: string): string {
    const payload = `${userId}.${Date.now() + SESSION_DAYS * 86400_000}`;
    return `${payload}.${this.sign(payload)}`;
  }

  verifySession(cookie: string | undefined): string | null {
    if (!cookie) return null;
    const i = cookie.lastIndexOf('.');
    if (i < 0) return null;
    const payload = cookie.slice(0, i);
    const sig = Buffer.from(cookie.slice(i + 1));
    const expected = Buffer.from(this.sign(payload));
    if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return null;
    const [userId, exp] = payload.split('.');
    if (!userId || Number(exp) < Date.now()) return null;
    return userId;
  }

  sessionCookie(value: string, maxAgeSeconds = SESSION_DAYS * 86400): string {
    const secure = this.options.publicUrl.startsWith('https://') ? '; Secure' : '';
    return `erd_session=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
  }

  // ── 개인 액세스 토큰 (MCP) ─────────────────────────────

  createToken(userId: string, name: string): { token: string; id: string; name: string; prefix: string; createdAt: string } {
    const token = `erd_${randomBytes(24).toString('base64url')}`;
    const record: TokenRecord = { id: randomUUID(), userId, name: name.trim() || 'MCP', hash: sha256(token), prefix: token.slice(0, 10), createdAt: new Date().toISOString() };
    putJson(this.storage, `tokens/${record.id}.json`, record);
    return { token, id: record.id, name: record.name, prefix: record.prefix, createdAt: record.createdAt };
  }

  listTokens(userId: string) {
    return this.storage
      .keys('tokens/')
      .map((k) => getJson<TokenRecord | null>(this.storage, k, null))
      .filter((t): t is TokenRecord => t?.userId === userId)
      .map(({ id, name, prefix, createdAt, lastUsedAt }) => ({ id, name, prefix, createdAt, lastUsedAt }));
  }

  revokeToken(userId: string, id: string): void {
    const t = getJson<TokenRecord | null>(this.storage, `tokens/${id}.json`, null);
    if (!t || t.userId !== userId) throw Object.assign(new Error('토큰을 찾을 수 없습니다'), { statusCode: 404 });
    this.storage.delete(`tokens/${id}.json`);
  }

  userFromToken(token: string): string | null {
    const hash = sha256(token);
    for (const key of this.storage.keys('tokens/')) {
      const t = getJson<TokenRecord | null>(this.storage, key, null);
      if (t && t.hash.length === hash.length && timingSafeEqual(Buffer.from(t.hash), Buffer.from(hash))) {
        // 마지막 사용 시각은 하루에 한 번 정도만 갱신
        if (!t.lastUsedAt || Date.now() - Date.parse(t.lastUsedAt) > 86400_000) putJson(this.storage, key, { ...t, lastUsedAt: new Date().toISOString() });
        return t.userId;
      }
    }
    return null;
  }

  // ── 프로젝트 권한 ─────────────────────────────

  access(projectId: string): ProjectAccess {
    return getJson<ProjectAccess>(this.storage, `projects/${projectId}/access.json`, { ownerId: LOCAL_USER.id, members: {}, shares: [] });
  }

  private saveAccess(projectId: string, access: ProjectAccess): void {
    putJson(this.storage, `projects/${projectId}/access.json`, access);
  }

  initProject(projectId: string, ownerId: string): void {
    this.saveAccess(projectId, { ownerId, members: { [ownerId]: 'owner' }, shares: [] });
  }

  role(projectId: string, userId: string): Role | null {
    if (!this.enabled) return 'owner';
    const access = this.access(projectId);
    if (access.ownerId === userId) return 'owner';
    return access.members[userId] ?? null;
  }

  createShare(projectId: string, role: Share['role'], createdBy: string): Share {
    const access = this.access(projectId);
    const share: Share = { token: randomBytes(18).toString('base64url'), role, createdAt: new Date().toISOString(), createdBy };
    access.shares.push(share);
    this.saveAccess(projectId, access);
    return share;
  }

  removeShare(projectId: string, token: string): void {
    const access = this.access(projectId);
    access.shares = access.shares.filter((s) => s.token !== token);
    this.saveAccess(projectId, access);
  }

  /** 초대 링크로 참여. 이미 더 높은 권한이 있으면 그대로 둔다. */
  join(token: string, userId: string, projectIds: string[]): { projectId: string; role: Role } {
    for (const projectId of projectIds) {
      const access = this.access(projectId);
      const share = access.shares.find((s) => s.token === token);
      if (!share) continue;
      const current = this.role(projectId, userId);
      if (!atLeast(current, share.role)) {
        access.members[userId] = share.role;
        this.saveAccess(projectId, access);
      }
      return { projectId, role: this.role(projectId, userId)! };
    }
    throw Object.assign(new Error('초대 링크가 올바르지 않거나 취소되었습니다'), { statusCode: 404 });
  }

  setMember(projectId: string, userId: string, role: Role | null): void {
    const access = this.access(projectId);
    if (userId === access.ownerId) throw Object.assign(new Error('소유자의 권한은 바꿀 수 없습니다'), { statusCode: 400 });
    if (role === null || role === 'owner') delete access.members[userId];
    if (role && role !== 'owner') access.members[userId] = role;
    this.saveAccess(projectId, access);
  }

  members(projectId: string) {
    const access = this.access(projectId);
    const ids = new Set([access.ownerId, ...Object.keys(access.members)]);
    return [...ids].map((id) => ({ user: this.user(id), role: id === access.ownerId ? ('owner' as Role) : access.members[id] }));
  }

  // ── DB 연결 주소 검사 ─────────────────────────────

  /**
   * 배포 환경에서 사용자가 서버 내부망(127.0.0.1, 10.x, 192.168.x, 클라우드 메타데이터 등)에 접속하게 만드는 것을 막는다.
   * 로컬 모드에서는 내 PC·사내망 DB에 붙는 것이 목적이므로 검사하지 않는다.
   */
  async assertAllowedDbHost(host: string): Promise<void> {
    if (!this.enabled || this.options.allowPrivateDb) return;
    const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
    const blocked = addresses.find(isPrivateAddress);
    if (blocked) {
      throw Object.assign(new Error(`보안을 위해 내부망 주소(${blocked})의 DB에는 연결할 수 없습니다. 내 PC·사내망 DB는 로컬 실행(npm run dev)으로 사용하세요.`), { statusCode: 403 });
    }
  }
}

export function isPrivateAddress(ip: string): boolean {
  if (ip.includes(':')) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::') return true;
    if (v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80')) return true;
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mapped ? isPrivateAddress(mapped[1]) : false;
  }
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // 링크 로컬, 클라우드 메타데이터
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) result[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return result;
}
