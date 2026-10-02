// 로그인, 내 정보, 개인 토큰, 프로젝트 공유·초대

import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { atLeast, parseCookies, type Auth, type Role } from '../auth';
import type { ProjectStore } from '../projects';

const badRequest = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode });

export function registerAuthRoutes(app: FastifyInstance, auth: Auth, projects: ProjectStore, serverDb = true) {
  const { publicUrl, github, devLogin } = auth.options;

  app.get('/api/me', async (req) => ({
    authEnabled: auth.enabled,
    user: req.user ?? null,
    loginMethods: [...(github ? ['github'] : []), ...(devLogin ? ['dev'] : [])],
    // false면 웹에서는 DB 연결 기능을 끄고 설치형 앱에서만 쓴다
    serverDb,
  }));

  // ── GitHub 로그인 ─────────────────────────────
  if (github) {
    app.get<{ Querystring: { return?: string } }>('/auth/github', async (req, reply) => {
      const state = randomBytes(16).toString('base64url');
      // MCP 로그인(OAuth) 허용 화면에서 왔으면 로그인 뒤 그 화면으로 돌아간다
      const back = req.query.return?.startsWith('/oauth/authorize?') ? req.query.return : '';
      const params = new URLSearchParams({
        client_id: github.clientId,
        redirect_uri: `${publicUrl}/auth/github/callback`,
        scope: 'read:user',
        state,
      });
      const secure = publicUrl.startsWith('https://') ? '; Secure' : '';
      reply
        .header('set-cookie', [
          `erd_oauth_state=${state}; Path=/auth; HttpOnly; SameSite=Lax; Max-Age=600${secure}`,
          `erd_return=${back ? encodeURIComponent(back) : ''}; Path=/auth; HttpOnly; SameSite=Lax; Max-Age=${back ? 600 : 0}${secure}`,
        ])
        .redirect(`https://github.com/login/oauth/authorize?${params}`);
    });

    app.get<{ Querystring: { code?: string; state?: string } }>('/auth/github/callback', async (req, reply) => {
      const { code, state } = req.query;
      const expected = parseCookies(req.headers.cookie).erd_oauth_state;
      if (!code || !state || state !== expected) throw badRequest('로그인 요청이 올바르지 않습니다. 다시 시도하세요.');
      const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: github.clientId, client_secret: github.clientSecret, code, redirect_uri: `${publicUrl}/auth/github/callback` }),
      });
      const token = (await tokenRes.json()) as { access_token?: string; error_description?: string };
      if (!token.access_token) throw badRequest(`GitHub 로그인 실패: ${token.error_description ?? '토큰을 받지 못했습니다'}`);
      const profileRes = await fetch('https://api.github.com/user', { headers: { Authorization: `Bearer ${token.access_token}`, 'User-Agent': 'erd' } });
      if (!profileRes.ok) throw badRequest('GitHub 사용자 정보를 읽지 못했습니다');
      const user = auth.upsertGithubUser((await profileRes.json()) as { id: number; login: string; name?: string; avatar_url?: string });
      const back = parseCookies(req.headers.cookie).erd_return ?? '';
      reply
        .header('set-cookie', [auth.sessionCookie(auth.createSession(user.id)), 'erd_oauth_state=; Path=/auth; Max-Age=0', 'erd_return=; Path=/auth; Max-Age=0'])
        .redirect(back.startsWith('/oauth/authorize?') ? `${publicUrl}${back}` : `${publicUrl}/`);
    });
  }

  // ── 개발·테스트용 로그인 (이름만) ─────────────────────────────
  if (devLogin) {
    app.post<{ Body: { name?: string } }>('/auth/dev', async (req, reply) => {
      const user = auth.devUser(req.body?.name ?? '');
      reply.header('set-cookie', auth.sessionCookie(auth.createSession(user.id)));
      return { user };
    });
  }

  app.post('/auth/logout', async (_req, reply) => {
    reply.header('set-cookie', auth.sessionCookie('', 0));
    return { ok: true };
  });

  // ── 개인 액세스 토큰 (MCP 연결용) ─────────────────────────────
  app.get('/api/tokens', async (req) => auth.listTokens(req.user.id));
  app.post<{ Body: { name?: string } }>('/api/tokens', async (req) => auth.createToken(req.user.id, req.body?.name ?? 'MCP'));
  app.delete<{ Params: { tokenId: string } }>('/api/tokens/:tokenId', async (req) => {
    auth.revokeToken(req.user.id, req.params.tokenId);
    return { ok: true };
  });

  // ── 공유 ─────────────────────────────
  app.get<{ Params: { id: string } }>('/api/projects/:id/access', async (req) => {
    const { id } = req.params;
    const myRole = auth.role(id, req.user.id);
    const access = auth.access(id);
    return {
      myRole,
      members: auth.members(id),
      // 초대 링크는 소유자에게만 보인다
      shares: atLeast(myRole, 'owner') ? access.shares.map((s) => ({ ...s, url: `${publicUrl}/#/join/${s.token}` })) : [],
    };
  });

  app.post<{ Params: { id: string }; Body: { role?: Role } }>('/api/projects/:id/shares', async (req) => {
    const role = req.body?.role;
    if (role !== 'editor' && role !== 'viewer') throw badRequest('role은 editor 또는 viewer여야 합니다');
    const share = auth.createShare(req.params.id, role, req.user.id);
    return { ...share, url: `${publicUrl}/#/join/${share.token}` };
  });

  app.delete<{ Params: { id: string; token: string } }>('/api/projects/:id/shares/:token', async (req) => {
    auth.removeShare(req.params.id, req.params.token);
    return { ok: true };
  });

  app.patch<{ Params: { id: string; userId: string }; Body: { role?: Role } }>('/api/projects/:id/members/:userId', async (req) => {
    const role = req.body?.role;
    if (role !== 'editor' && role !== 'viewer') throw badRequest('role은 editor 또는 viewer여야 합니다');
    auth.setMember(req.params.id, req.params.userId, role);
    return { ok: true };
  });

  app.delete<{ Params: { id: string; userId: string } }>('/api/projects/:id/members/:userId', async (req) => {
    auth.setMember(req.params.id, req.params.userId, null);
    return { ok: true };
  });

  app.post<{ Params: { token: string } }>('/api/join/:token', async (req) => auth.join(req.params.token, req.user.id, projects.list().map((p) => p.id)));
}

/**
 * /api/projects/:id... 요청에 필요한 권한.
 * 읽기는 viewer, 고치기는 editor, 프로젝트 삭제·공유 관리는 owner.
 */
export function requiredRole(method: string, routeUrl: string): Role {
  const owner = [
    'DELETE /api/projects/:id',
    'POST /api/projects/:id/shares',
    'DELETE /api/projects/:id/shares/:token',
    'PATCH /api/projects/:id/members/:userId',
    'DELETE /api/projects/:id/members/:userId',
  ];
  if (owner.includes(`${method} ${routeUrl}`)) return 'owner';
  return method === 'GET' || method === 'HEAD' ? 'viewer' : 'editor';
}
