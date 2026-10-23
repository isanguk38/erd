// 관리자 페이지 API: 공지사항·업데이트 소식 쓰기, 관리자 초대·관리. 공지 읽기는 로그인한 누구나.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AdminInvite, AdminRole, AdminStore, NoticeInput, NoticeKind, NoticeStore } from '../admin';

const forbidden = (message: string) => Object.assign(new Error(message), { statusCode: 403 });

/** 화면에 보낼 초대 (토큰 해시는 빼고) */
const publicInvite = ({ hash: _hash, ...rest }: AdminInvite) => ({ ...rest, status: rest.usedBy ? 'used' : Date.parse(rest.expiresAt) < Date.now() ? 'expired' : 'open' });

export function registerAdminRoutes(app: FastifyInstance, admins: AdminStore, notices: NoticeStore, options: { publicUrl: string; owners: string[] }) {
  const need = (req: FastifyRequest, role: AdminRole = 'admin'): AdminRole => {
    const mine = admins.role(req.user);
    if (!mine) throw forbidden('관리자만 할 수 있습니다');
    if (role === 'owner' && mine !== 'owner') throw forbidden('주인 관리자만 할 수 있습니다');
    return mine;
  };

  // ── 누구나 (로그인한 사용자): 게시한 소식 읽기 ─────────────
  app.get<{ Querystring: { limit?: string; kind?: NoticeKind } }>('/api/notices', async (req) => {
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));
    return notices.published(limit, req.query.kind).map(({ revisions: _r, createdBy: _c, updatedBy: _u, ...n }) => n);
  });

  /** 내가 관리자인지 (화면의 "관리자 페이지" 메뉴) */
  app.get('/api/admin/me', async (req) => ({ role: admins.role(req.user) }));

  /** 관리자 초대 수락 (GitHub·Microsoft로 로그인한 상태에서) */
  app.post<{ Body: { token?: string } }>('/api/admin/invites/accept', async (req) => {
    if (!req.user) throw forbidden('로그인이 필요합니다');
    if (admins.role(req.user)) return { ok: true, already: true, role: admins.role(req.user) };
    const entry = admins.accept(String(req.body?.token ?? ''), req.user);
    return { ok: true, role: 'admin', entry };
  });

  // ── 관리자: 소식 쓰기 ─────────────
  app.get('/api/admin/notices', async (req) => {
    need(req);
    return notices.all();
  });
  app.post<{ Body: NoticeInput }>('/api/admin/notices', async (req) => {
    need(req);
    return notices.create(req.body ?? {}, req.user);
  });
  app.patch<{ Params: { id: string }; Body: NoticeInput }>('/api/admin/notices/:id', async (req) => {
    need(req);
    return notices.update(req.params.id, req.body ?? {}, req.user);
  });
  app.post<{ Params: { id: string }; Body: { at?: string } }>('/api/admin/notices/:id/restore', async (req) => {
    need(req);
    return notices.restore(req.params.id, String(req.body?.at ?? ''), req.user);
  });
  app.delete<{ Params: { id: string } }>('/api/admin/notices/:id', async (req) => {
    need(req);
    notices.remove(req.params.id);
    return { ok: true };
  });

  // ── 주인: 관리자 초대·관리 ─────────────
  app.get('/api/admin/admins', async (req) => {
    need(req, 'owner');
    return { owners: options.owners, admins: admins.list(), invites: admins.invites().map(publicInvite) };
  });
  app.post<{ Body: { login?: string } }>('/api/admin/invites', async (req) => {
    need(req, 'owner');
    const { invite, token } = admins.createInvite(req.user, req.body?.login);
    // 링크는 지금 한 번만 보여 준다 (서버에는 해시만 남는다)
    return { invite: publicInvite(invite), url: `${options.publicUrl}/#/admin/join/${token}` };
  });
  app.delete<{ Params: { id: string } }>('/api/admin/invites/:id', async (req) => {
    need(req, 'owner');
    admins.cancelInvite(req.params.id);
    return { ok: true };
  });
  app.delete<{ Params: { userId: string } }>('/api/admin/admins/:userId', async (req) => {
    need(req, 'owner');
    admins.remove(req.params.userId);
    return { ok: true };
  });
}
