// MCP 로그인(OAuth) 주소들. 흐름 설명은 ../oauth.ts
import type { FastifyInstance, FastifyReply } from 'fastify';
import { parseCookies, type Auth } from '../auth';
import { OAuthError, type OAuthStore } from '../oauth';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** 허용·로그인 화면 (작은 단독 HTML) */
function page(reply: FastifyReply, title: string, body: string, status = 200) {
  reply
    .status(status)
    .header('content-type', 'text/html; charset=utf-8')
    // 다른 사이트가 이 화면을 몰래 띄워 "허용"을 누르게 하지 못하게
    .header('x-frame-options', 'DENY')
    .header('content-security-policy', "frame-ancestors 'none'")
    .header('cache-control', 'no-store')
    .send(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · ERD</title>
<style>
  :root { color-scheme: light dark; --fg:#0f172a; --muted:#64748b; --bg:#f8fafc; --card:#fff; --border:#e2e8f0; --primary:#2563eb; }
  @media (prefers-color-scheme: dark) { :root { --fg:#e2e8f0; --muted:#94a3b8; --bg:#0b1220; --card:#111827; --border:#1f2937; } }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:var(--bg); color:var(--fg); font-family:system-ui,-apple-system,'Malgun Gothic',sans-serif; }
  .card { width:min(420px, calc(100vw - 32px)); background:var(--card); border:1px solid var(--border); border-radius:12px; padding:28px; box-shadow:0 10px 30px rgba(0,0,0,.08); }
  h1 { font-size:20px; margin:0 0 6px; } p { line-height:1.6; margin:10px 0; } .muted { color:var(--muted); font-size:13px; }
  .who { display:flex; gap:10px; align-items:center; padding:10px 12px; border:1px solid var(--border); border-radius:8px; margin:14px 0; }
  .who img { width:28px; height:28px; border-radius:50%; }
  ul { padding-left:18px; margin:8px 0; font-size:14px; } li { margin:3px 0; }
  .actions { display:flex; gap:8px; justify-content:flex-end; margin-top:20px; }
  button, .btn { font:inherit; padding:8px 16px; border-radius:8px; border:1px solid var(--border); background:transparent; color:var(--fg); cursor:pointer; text-decoration:none; display:inline-block; }
  .primary { background:var(--primary); border-color:var(--primary); color:#fff; }
  input { font:inherit; padding:8px; border:1px solid var(--border); border-radius:8px; width:100%; box-sizing:border-box; background:transparent; color:var(--fg); }
  .logo { font-weight:700; color:var(--primary); margin-bottom:14px; }
</style></head><body><main class="card"><div class="logo">ERD</div>${body}</main></body></html>`);
}

export function registerOAuthRoutes(app: FastifyInstance, auth: Auth, oauth: OAuthStore) {
  const { publicUrl, github, devLogin } = auth.options;
  const resource = `${publicUrl}/mcp`;

  // OAuth 토큰 요청은 form(application/x-www-form-urlencoded)으로 온다
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  // ── 서버 정보 (MCP 클라이언트가 로그인 방법을 스스로 찾는다) ─────────────────────────────
  const protectedResource = async () => ({
    resource,
    authorization_servers: [publicUrl],
    bearer_methods_supported: ['header'],
    resource_name: 'ERD',
  });
  app.get('/.well-known/oauth-protected-resource', protectedResource);
  app.get('/.well-known/oauth-protected-resource/mcp', protectedResource);

  const serverMetadata = async () => ({
    issuer: publicUrl,
    authorization_endpoint: `${publicUrl}/oauth/authorize`,
    token_endpoint: `${publicUrl}/oauth/token`,
    registration_endpoint: `${publicUrl}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['erd'],
  });
  app.get('/.well-known/oauth-authorization-server', serverMetadata);
  app.get('/.well-known/oauth-authorization-server/mcp', serverMetadata);

  const oauthError = (reply: FastifyReply, e: unknown) => {
    if (e instanceof OAuthError) return reply.status(e.statusCode).header('cache-control', 'no-store').send({ error: e.code, error_description: e.message });
    throw e;
  };

  // ── 클라이언트 자동 등록 ─────────────────────────────
  app.post<{ Body: Record<string, unknown> }>('/oauth/register', async (req, reply) => {
    try {
      const client = oauth.register(req.body ?? {});
      return reply.status(201).send({
        client_id: client.client_id,
        client_id_issued_at: Math.floor(Date.parse(client.createdAt) / 1000),
        client_name: client.client_name,
        redirect_uris: client.redirect_uris,
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      });
    } catch (e) {
      return oauthError(reply, e);
    }
  });

  // ── 로그인 + 허용 화면 ─────────────────────────────
  app.get<{ Querystring: Record<string, string> }>('/oauth/authorize', async (req, reply) => {
    let started;
    try {
      started = oauth.startAuthorize(req.query);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return page(reply, '연결할 수 없습니다', `<h1>연결할 수 없습니다</h1><p>${esc(message)}</p>`, 400);
    }
    const userId = auth.verifySession(parseCookies(req.headers.cookie).erd_session);
    const user = userId ? auth.user(userId) : null;
    const here = req.url;
    if (!user) {
      const options = [
        github ? `<a class="btn primary" href="/auth/github?return=${encodeURIComponent(here)}">GitHub로 로그인</a>` : '',
        devLogin
          ? `<form method="post" action="/oauth/dev-login" style="margin-top:12px"><input type="hidden" name="return" value="${esc(here)}"><input name="name" placeholder="이름 (개발용 로그인)" required><div class="actions"><button class="primary">로그인</button></div></form>`
          : '',
      ].join('');
      return page(
        reply,
        '로그인',
        `<h1>ERD에 로그인하세요</h1><p><b>${esc(started.client.client_name)}</b>을(를) ERD에 연결하려면 먼저 로그인해야 합니다.</p><div class="actions">${options}</div>`,
      );
    }
    return page(
      reply,
      '연결 허용',
      `<h1>${esc(started.client.client_name)} 연결</h1>
<p><b>${esc(started.client.client_name)}</b>이(가) 내 ERD 계정에 접근하려고 합니다.</p>
<div class="who">${user.avatarUrl ? `<img src="${esc(user.avatarUrl)}" alt="">` : ''}<div><b>${esc(user.name)}</b><div class="muted">${esc(user.login)}</div></div></div>
<p class="muted">허용하면 AI가 MCP로 할 수 있는 일</p>
<ul><li>내가 볼 수 있는 프로젝트 읽기</li><li>편집 권한이 있는 프로젝트 고치기 (화면에서 되돌릴 수 있음)</li><li>SQL·정의서 만들기</li></ul>
<p class="muted">연결은 ERD 화면의 "AI 연결 → 연결된 앱"에서 언제든 끊을 수 있습니다.</p>
<form method="post" action="/oauth/authorize">
  <input type="hidden" name="request_id" value="${esc(started.requestId)}">
  <div class="actions"><button name="decision" value="deny">거부</button><button class="primary" name="decision" value="allow" autofocus>허용</button></div>
</form>`,
    );
  });

  app.post<{ Body: { request_id?: string; decision?: string } }>('/oauth/authorize', async (req, reply) => {
    const userId = auth.verifySession(parseCookies(req.headers.cookie).erd_session);
    if (!userId) return page(reply, '로그인 필요', '<h1>로그인이 풀렸습니다</h1><p>MCP 연결을 처음부터 다시 시도하세요.</p>', 401);
    try {
      return reply.redirect(oauth.finishAuthorize(req.body?.request_id ?? '', userId, req.body?.decision === 'allow'), 302);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return page(reply, '연결할 수 없습니다', `<h1>연결할 수 없습니다</h1><p>${esc(message)}</p>`, 400);
    }
  });

  // 개발·테스트용 로그인 (이름만). 운영(GitHub 로그인)에서는 켜지 않는다.
  if (devLogin) {
    app.post<{ Body: { name?: string; return?: string } }>('/oauth/dev-login', async (req, reply) => {
      const user = auth.devUser(req.body?.name ?? '');
      const back = req.body?.return ?? '';
      reply.header('set-cookie', auth.sessionCookie(auth.createSession(user.id)));
      return reply.redirect(back.startsWith('/oauth/authorize?') ? back : '/', 302);
    });
  }

  // ── 토큰 ─────────────────────────────
  app.post<{ Body: Record<string, string | undefined> }>('/oauth/token', async (req, reply) => {
    const body = req.body ?? {};
    try {
      const tokens =
        body.grant_type === 'authorization_code'
          ? oauth.exchangeCode(body)
          : body.grant_type === 'refresh_token'
            ? oauth.refresh(body)
            : (() => {
                throw new OAuthError('unsupported_grant_type', 'authorization_code 또는 refresh_token만 지원합니다');
              })();
      return reply.header('cache-control', 'no-store').send(tokens);
    } catch (e) {
      return oauthError(reply, e);
    }
  });

  // ── 연결된 앱 (화면에서 보기·끊기) ─────────────────────────────
  app.get('/api/oauth/grants', async (req) =>
    oauth.listGrants(req.user.id).map(({ id, clientName, createdAt, lastUsedAt }) => ({ id, clientName, createdAt, lastUsedAt })),
  );
  app.delete<{ Params: { id: string } }>('/api/oauth/grants/:id', async (req) => {
    oauth.revokeGrant(req.user.id, req.params.id);
    return { ok: true };
  });
}
