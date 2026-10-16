// 공지사항·업데이트 소식과 관리자 페이지 API, 그리고 "읽음" 기억(이 기기·브라우저마다).

import { useEffect, useState } from 'react';

export type NoticeKind = 'notice' | 'web' | 'app';

export const NOTICE_KIND_LABEL: Record<NoticeKind, string> = { notice: '공지', web: '웹 업데이트', app: '앱 업데이트' };

export interface NoticeItem {
  id: string;
  kind: NoticeKind;
  title: string;
  body: string;
  version?: string;
  pinned: boolean;
  published: boolean;
  publishedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AdminNotice extends NoticeItem {
  createdBy: string;
  updatedBy: string;
  revisions: { at: string; by: string; title: string; body: string; kind: NoticeKind; version?: string; pinned: boolean }[];
}

export interface AdminInviteInfo {
  id: string;
  login?: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  usedBy?: string;
  usedAt?: string;
  status: 'open' | 'used' | 'expired';
}

export interface AdminEntry {
  userId: string;
  login: string;
  name: string;
  addedAt: string;
  addedBy: string;
}

export type NoticeInput = Partial<Pick<AdminNotice, 'kind' | 'title' | 'body' | 'pinned' | 'published'>> & { version?: string | null };

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, { method, headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `요청 실패 (${res.status})`);
  return data as T;
}

export const noticeApi = {
  list: (limit = 10) => call<NoticeItem[]>('GET', `/api/notices?limit=${limit}`),
};

export const adminApi = {
  me: () => call<{ role: 'owner' | 'admin' | null }>('GET', '/api/admin/me'),
  notices: () => call<AdminNotice[]>('GET', '/api/admin/notices'),
  create: (input: NoticeInput) => call<AdminNotice>('POST', '/api/admin/notices', input),
  update: (id: string, input: NoticeInput) => call<AdminNotice>('PATCH', `/api/admin/notices/${id}`, input),
  restore: (id: string, at: string) => call<AdminNotice>('POST', `/api/admin/notices/${id}/restore`, { at }),
  remove: (id: string) => call('DELETE', `/api/admin/notices/${id}`),
  admins: () => call<{ owners: string[]; admins: AdminEntry[]; invites: AdminInviteInfo[] }>('GET', '/api/admin/admins'),
  invite: (login?: string) => call<{ invite: AdminInviteInfo; url: string }>('POST', '/api/admin/invites', { login }),
  cancelInvite: (id: string) => call('DELETE', `/api/admin/invites/${id}`),
  removeAdmin: (userId: string) => call('DELETE', `/api/admin/admins/${userId}`),
  accept: (token: string) => call<{ ok: true; role: string }>('POST', '/api/admin/invites/accept', { token }),
};

/** 내가 관리자인지 (한 번 묻고 기억) */
let rolePromise: Promise<'owner' | 'admin' | null> | null = null;
export function useAdminRole(): 'owner' | 'admin' | null {
  const [role, setRole] = useState<'owner' | 'admin' | null>(null);
  useEffect(() => {
    rolePromise ??= adminApi.me().then((r) => r.role).catch(() => null);
    let alive = true;
    void rolePromise.then((r) => alive && setRole(r));
    return () => {
      alive = false;
    };
  }, []);
  return role;
}
/** 초대를 수락하면 다시 묻는다 */
export const forgetAdminRole = () => {
  rolePromise = null;
};

// ── 읽음 기억 (이 브라우저·앱마다) ─────────────
const SEEN_KEY = 'erd.notices.seen';
export function seenNotices(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}
export function markNoticesSeen(ids: string[]): void {
  try {
    const next = [...new Set([...seenNotices(), ...ids])].slice(-300);
    localStorage.setItem(SEEN_KEY, JSON.stringify(next));
  } catch {
    // 저장이 막혀 있으면 이번에만
  }
}
