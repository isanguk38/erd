// MCP 로그인 (OAuth 2.1 + PKCE). Claude 등 MCP 클라이언트가 토큰을 복사해 붙이지 않고
// 브라우저에서 ERD에 로그인한 뒤 "허용"을 누르면 연결된다. ("재인증"도 이 흐름을 다시 탄다)
//
// 흐름: MCP가 401 + 안내 주소를 받음 → 서버 정보(/.well-known/...) 읽기 → 클라이언트 자동 등록(/oauth/register)
//      → 브라우저로 /oauth/authorize (ERD 로그인 + 허용) → 받은 code로 /oauth/token → access_token(1시간) + refresh_token
//
// 기존 개인 액세스 토큰(erd_...)은 그대로 쓸 수 있다. OAuth 토큰은 erdo_로 시작한다.

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { getJson, putJson, type Storage } from './storage';

const ACCESS_TTL = 60 * 60; // 초
const REFRESH_TTL = 90 * 86400; // 초
const CODE_TTL = 5 * 60 * 1000;
const REQUEST_TTL = 10 * 60 * 1000;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const base64url = (buf: Buffer) => buf.toString('base64url');

export interface OAuthClient {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  createdAt: string;
}

/** 사용자가 "허용"한 연결 하나 (연결된 앱 목록·연결 끊기 단위) */
export interface OAuthGrant {
  id: string;
  userId: string;
  clientId: string;
  clientName: string;
  createdAt: string;
  lastUsedAt?: string;
}

interface TokenRecord {
  grantId: string;
  userId: string;
  clientId: string;
  expiresAt: number;
}

/** 허용 화면에 보여 주는 동안 기억하는 요청 */
export interface AuthorizeRequest {
  clientId: string;
  redirectUri: string;
  state?: string;
  codeChallenge: string;
  scope?: string;
}

interface CodeRecord extends AuthorizeRequest {
  userId: string;
  expiresAt: number;
}

export class OAuthError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 400) {
    super(message);
  }
}

/** redirect_uri는 https이거나, 내 PC(localhost)의 http만 허용한다 */
export function validRedirectUri(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.hash) return false;
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}

/** 등록한 주소와 같은지. 내 PC 주소는 포트가 달라도 같다고 본다 (RFC 8252) */
function sameRedirect(registered: string, given: string): boolean {
  if (registered === given) return true;
  try {
    const a = new URL(registered);
    const b = new URL(given);
    const loopback = ['localhost', '127.0.0.1', '[::1]'];
    return a.protocol === 'http:' && loopback.includes(a.hostname) && a.hostname === b.hostname && a.pathname === b.pathname && a.search === b.search;
  } catch {
    return false;
  }
}

export class OAuthStore {
  /** 허용 화면 요청·발급한 code는 짧게 쓰고 버리므로 메모리에 둔다 */
  private readonly requests = new Map<string, AuthorizeRequest & { expiresAt: number }>();
  private readonly codes = new Map<string, CodeRecord>();

  constructor(private readonly storage: Storage) {}

  // ── 클라이언트 등록 (RFC 7591) ─────────────────────────────

  register(input: { client_name?: unknown; redirect_uris?: unknown }): OAuthClient {
    const uris = Array.isArray(input.redirect_uris) ? input.redirect_uris.filter((u): u is string => typeof u === 'string') : [];
    if (!uris.length || uris.length > 10 || !uris.every(validRedirectUri)) {
      throw new OAuthError('invalid_redirect_uri', 'redirect_uris는 https 주소 또는 localhost 주소여야 합니다');
    }
    const name = typeof input.client_name === 'string' && input.client_name.trim() ? input.client_name.trim().slice(0, 80) : 'MCP 클라이언트';
    const client: OAuthClient = { client_id: `erdc_${base64url(randomBytes(16))}`, client_name: name, redirect_uris: uris, createdAt: new Date().toISOString() };
    putJson(this.storage, `oauth/clients/${client.client_id}.json`, client);
    return client;
  }

  client(clientId: string): OAuthClient | null {
    if (!/^erdc_[\w-]+$/.test(clientId)) return null;
    return getJson<OAuthClient | null>(this.storage, `oauth/clients/${clientId}.json`, null);
  }

  // ── 허용 화면 ─────────────────────────────

  /** /oauth/authorize 요청을 검사하고, 허용 화면이 다시 보낼 요청 번호를 돌려준다 */
  startAuthorize(query: Record<string, string | undefined>): { requestId: string; client: OAuthClient; request: AuthorizeRequest } {
    const client = this.client(query.client_id ?? '');
    if (!client) throw new OAuthError('invalid_client', '등록되지 않은 클라이언트입니다. MCP 연결을 처음부터 다시 시도하세요.');
    const redirectUri = query.redirect_uri ?? '';
    if (!client.redirect_uris.some((r) => sameRedirect(r, redirectUri))) throw new OAuthError('invalid_request', '등록되지 않은 redirect_uri입니다');
    if (query.response_type !== 'code') throw new OAuthError('unsupported_response_type', 'response_type=code만 지원합니다');
    if (!query.code_challenge || (query.code_challenge_method ?? 'plain') !== 'S256') throw new OAuthError('invalid_request', 'PKCE(code_challenge, S256)가 필요합니다');
    this.prune();
    const request: AuthorizeRequest = { clientId: client.client_id, redirectUri, state: query.state, codeChallenge: query.code_challenge, scope: query.scope };
    const requestId = base64url(randomBytes(18));
    this.requests.set(requestId, { ...request, expiresAt: Date.now() + REQUEST_TTL });
    return { requestId, client, request };
  }

  /** 허용/거부 → 클라이언트로 돌려보낼 주소 */
  finishAuthorize(requestId: string, userId: string, approve: boolean): string {
    const request = this.requests.get(requestId);
    this.requests.delete(requestId);
    if (!request || request.expiresAt < Date.now()) throw new OAuthError('invalid_request', '허용 요청이 만료되었습니다. MCP 연결을 다시 시도하세요.');
    const url = new URL(request.redirectUri);
    if (request.state) url.searchParams.set('state', request.state);
    if (!approve) {
      url.searchParams.set('error', 'access_denied');
      return url.toString();
    }
    const code = base64url(randomBytes(32));
    this.codes.set(sha256(code), { ...request, userId, expiresAt: Date.now() + CODE_TTL });
    url.searchParams.set('code', code);
    return url.toString();
  }

  // ── 토큰 ─────────────────────────────

  exchangeCode(params: Record<string, string | undefined>) {
    const key = sha256(params.code ?? '');
    const record = this.codes.get(key);
    this.codes.delete(key); // 한 번만 쓴다
    if (!record || record.expiresAt < Date.now()) throw new OAuthError('invalid_grant', 'code가 올바르지 않거나 만료되었습니다');
    if (params.client_id && params.client_id !== record.clientId) throw new OAuthError('invalid_grant', 'client_id가 다릅니다');
    if (params.redirect_uri && params.redirect_uri !== record.redirectUri) throw new OAuthError('invalid_grant', 'redirect_uri가 다릅니다');
    const verifier = params.code_verifier ?? '';
    const challenge = base64url(createHash('sha256').update(verifier).digest());
    if (!verifier || !safeEqual(challenge, record.codeChallenge)) throw new OAuthError('invalid_grant', 'code_verifier가 맞지 않습니다');
    const client = this.client(record.clientId);
    const grant: OAuthGrant = { id: randomUUID(), userId: record.userId, clientId: record.clientId, clientName: client?.client_name ?? 'MCP 클라이언트', createdAt: new Date().toISOString() };
    putJson(this.storage, `oauth/grants/${grant.id}.json`, grant);
    return this.issue(grant, record.scope);
  }

  refresh(params: Record<string, string | undefined>) {
    const key = `oauth/refresh/${sha256(params.refresh_token ?? '')}.json`;
    const record = getJson<TokenRecord | null>(this.storage, key, null);
    if (!record || record.expiresAt < Date.now()) throw new OAuthError('invalid_grant', 'refresh_token이 올바르지 않거나 만료되었습니다');
    if (params.client_id && params.client_id !== record.clientId) throw new OAuthError('invalid_grant', 'client_id가 다릅니다');
    const grant = this.grant(record.grantId);
    if (!grant) throw new OAuthError('invalid_grant', '연결이 끊긴 앱입니다. 다시 로그인하세요');
    this.storage.delete(key); // 쓸 때마다 새 refresh_token으로 바꾼다
    return this.issue(grant, params.scope);
  }

  private issue(grant: OAuthGrant, scope?: string) {
    const access = `erdo_${base64url(randomBytes(32))}`;
    const refresh = `erdr_${base64url(randomBytes(32))}`;
    const base = { grantId: grant.id, userId: grant.userId, clientId: grant.clientId };
    putJson(this.storage, `oauth/access/${sha256(access)}.json`, { ...base, expiresAt: Date.now() + ACCESS_TTL * 1000 } satisfies TokenRecord);
    putJson(this.storage, `oauth/refresh/${sha256(refresh)}.json`, { ...base, expiresAt: Date.now() + REFRESH_TTL * 1000 } satisfies TokenRecord);
    return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL, refresh_token: refresh, ...(scope ? { scope } : {}) };
  }

  /** MCP·API 요청의 Bearer 토큰(erdo_...) → 사용자 id */
  userFromAccessToken(token: string): string | null {
    if (!token.startsWith('erdo_')) return null;
    const key = `oauth/access/${sha256(token)}.json`;
    const record = getJson<TokenRecord | null>(this.storage, key, null);
    if (!record) return null;
    if (record.expiresAt < Date.now()) {
      this.storage.delete(key);
      return null;
    }
    const grant = this.grant(record.grantId);
    if (!grant) return null;
    // 마지막 사용 시각은 한 시간에 한 번 정도만 갱신
    if (!grant.lastUsedAt || Date.now() - Date.parse(grant.lastUsedAt) > 3600_000) {
      putJson(this.storage, `oauth/grants/${grant.id}.json`, { ...grant, lastUsedAt: new Date().toISOString() });
    }
    return record.userId;
  }

  // ── 연결된 앱 ─────────────────────────────

  grant(id: string): OAuthGrant | null {
    return getJson<OAuthGrant | null>(this.storage, `oauth/grants/${id}.json`, null);
  }

  listGrants(userId: string): OAuthGrant[] {
    return this.storage
      .keys('oauth/grants/')
      .map((k) => getJson<OAuthGrant | null>(this.storage, k, null))
      .filter((g): g is OAuthGrant => g?.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** 연결 끊기: 그 연결로 받은 토큰은 바로 쓸 수 없게 된다 (토큰 검사가 연결을 확인한다) */
  revokeGrant(userId: string, id: string): void {
    const grant = this.grant(id);
    if (!grant || grant.userId !== userId) throw Object.assign(new Error('연결을 찾을 수 없습니다'), { statusCode: 404 });
    this.storage.delete(`oauth/grants/${id}.json`);
  }

  private prune() {
    const now = Date.now();
    for (const [k, v] of this.requests) if (v.expiresAt < now) this.requests.delete(k);
    for (const [k, v] of this.codes) if (v.expiresAt < now) this.codes.delete(k);
  }
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
