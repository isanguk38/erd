// 관리자: 공지사항·업데이트 소식을 쓰는 사람. 계정은 따로 만들지 않고 로그인 계정(GitHub·Microsoft)에 "관리자" 권한만 붙인다
// (프로젝트 권한과는 따로라 관리자여도 남의 프로젝트는 볼 수 없고, 관리자를 빼도 그 사람의 프로젝트는 그대로).
// - 주인(owner): 서버 설정 ERD_ADMIN_GITHUB에 적은 계정 (GitHub 아이디 또는 Microsoft 이메일, 화면에서 뺄 수 없음). 로컬 모드에서는 내 PC 사용자.
// - 관리자(admin): 주인이 만든 초대 링크(한 번만, 24시간, 특정 계정(GitHub 아이디·Microsoft 이메일)만 가능하게도)로 승인된 계정.

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { User } from './auth';
import { getJson, putJson, type Storage } from './storage';

export type AdminRole = 'owner' | 'admin';

export interface AdminEntry {
  userId: string;
  login: string;
  name: string;
  addedAt: string;
  addedBy: string;
}

export interface AdminInvite {
  id: string;
  /** 링크 토큰은 저장하지 않고 해시만 둔다 */
  hash: string;
  /** 이 GitHub 아이디만 수락할 수 있다 (비우면 링크를 받은 누구나) */
  login?: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  usedBy?: string;
  usedAt?: string;
}

const INVITE_TTL_MS = 24 * 60 * 60 * 1000;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const KEY = 'admin/admins.json';
const inviteKey = (id: string) => `admin/invites/${id}.json`;

export class AdminStore {
  /** owners: 서버 설정의 GitHub 아이디·Microsoft 이메일 또는 숫자 GitHub id. localOwner: 로컬 모드(로그인 없음)면 내 PC 사용자가 주인 */
  constructor(private readonly storage: Storage, private readonly owners: string[], private readonly localOwner: boolean) {}

  private isOwner(user: User): boolean {
    if (this.localOwner) return true;
    return this.owners.some((o) => (/^\d+$/.test(o) ? user.githubId === Number(o) : o.toLowerCase() === user.login.toLowerCase()));
  }

  role(user: User | null | undefined): AdminRole | null {
    if (!user) return null;
    if (this.isOwner(user)) return 'owner';
    return this.list().some((a) => a.userId === user.id) ? 'admin' : null;
  }

  list(): AdminEntry[] {
    return getJson<AdminEntry[]>(this.storage, KEY, []);
  }

  remove(userId: string): void {
    putJson(this.storage, KEY, this.list().filter((a) => a.userId !== userId));
  }

  createInvite(by: User, login?: string): { invite: AdminInvite; token: string } {
    const token = randomBytes(24).toString('base64url');
    const now = Date.now();
    const invite: AdminInvite = {
      id: randomUUID(),
      hash: sha(token),
      ...(login?.trim() ? { login: login.trim().replace(/^@/, '') } : {}),
      createdBy: by.login,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + INVITE_TTL_MS).toISOString(),
    };
    putJson(this.storage, inviteKey(invite.id), invite);
    // 토큰에 초대 id를 붙여 바로 찾는다 (토큰 자체는 해시로만 비교)
    return { invite, token: `${invite.id}.${token}` };
  }

  invites(): AdminInvite[] {
    return this.storage
      .keys('admin/invites/')
      .map((k) => getJson<AdminInvite | null>(this.storage, k, null))
      .filter((i): i is AdminInvite => Boolean(i))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  cancelInvite(id: string): void {
    this.storage.delete(inviteKey(id));
  }

  /** 초대 수락: 한 번만, 만료 전, 계정(GitHub 아이디·Microsoft 이메일)을 지정했으면 그 계정만 */
  accept(raw: string, user: User): AdminEntry {
    const [id, token] = raw.split('.');
    const invite = id && token ? getJson<AdminInvite | null>(this.storage, inviteKey(id), null) : null;
    const fail = (message: string) => Object.assign(new Error(message), { statusCode: 400 });
    if (!invite || invite.hash !== sha(token!)) throw fail('초대 링크가 올바르지 않습니다');
    if (invite.usedBy) throw fail('이미 사용한 초대 링크입니다');
    if (Date.parse(invite.expiresAt) < Date.now()) throw fail('만료된 초대 링크입니다. 관리자에게 새 링크를 받으세요');
    if (invite.login && invite.login.toLowerCase() !== user.login.toLowerCase()) throw fail(`이 초대는 ${invite.login.includes('@') ? 'Microsoft' : 'GitHub'} 계정 ${invite.login}만 수락할 수 있습니다 (지금 로그인: ${user.login})`);
    putJson(this.storage, inviteKey(invite.id), { ...invite, usedBy: user.login, usedAt: new Date().toISOString() });
    const entry: AdminEntry = { userId: user.id, login: user.login, name: user.name, addedAt: new Date().toISOString(), addedBy: invite.createdBy };
    if (!this.isOwner(user)) putJson(this.storage, KEY, [...this.list().filter((a) => a.userId !== user.id), entry]);
    return entry;
  }
}

// ── 공지사항·업데이트 소식 ─────────────────────────────

/** notice: 공지·주의사항, web: 웹 업데이트, app: 설치형 앱 업데이트 (버전과 함께) */
export type NoticeKind = 'notice' | 'web' | 'app';
export const NOTICE_KINDS: NoticeKind[] = ['notice', 'web', 'app'];

/** 글 형식: html(편집기에서 쓴 글, 기본), markdown(예전 글·GitHub 릴리스 설명) */
export type NoticeFormat = 'html' | 'markdown';

export interface NoticeRevision {
  at: string;
  by: string;
  title: string;
  body: string;
  format?: NoticeFormat;
  kind: NoticeKind;
  version?: string;
  pinned: boolean;
}

export interface Notice {
  id: string;
  kind: NoticeKind;
  title: string;
  /** 내용 (format에 따라 HTML 또는 마크다운). 보여 줄 때 화면이 위험한 태그·스크립트를 걸러 낸다 */
  body: string;
  /** 없으면 markdown (예전 글) */
  format?: NoticeFormat;
  /** 앱 업데이트 글이면 그 앱 버전 (예: 0.2.9) */
  version?: string;
  /** 위에 고정 (중요한 주의사항) */
  pinned: boolean;
  published: boolean;
  publishedAt?: string;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
  /** 고치기 전 내용 (최근 것부터, 최대 30개) */
  revisions: NoticeRevision[];
}

export interface NoticeInput {
  kind?: NoticeKind;
  title?: string;
  body?: string;
  format?: NoticeFormat;
  version?: string | null;
  pinned?: boolean;
  published?: boolean;
}

const noticeKey = (id: string) => `notices/${id}.json`;
const MAX_REVISIONS = 30;

export class NoticeStore {
  constructor(private readonly storage: Storage) {}

  all(): Notice[] {
    return this.storage
      .keys('notices/')
      .map((k) => getJson<Notice | null>(this.storage, k, null))
      .filter((n): n is Notice => Boolean(n))
      .sort((a, b) => (b.publishedAt ?? b.createdAt).localeCompare(a.publishedAt ?? a.createdAt));
  }

  /** 게시한 것만 (고정한 것 먼저, 그다음 최근 것) */
  published(limit = 20, kind?: NoticeKind): Notice[] {
    return this.all()
      .filter((n) => n.published && (!kind || n.kind === kind))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''))
      .slice(0, limit);
  }

  get(id: string): Notice | null {
    return getJson<Notice | null>(this.storage, noticeKey(id), null);
  }

  /** 이 앱 버전의 게시한 업데이트 글 */
  appNotes(version: string): Notice | null {
    return this.all().find((n) => n.published && n.kind === 'app' && n.version === version) ?? null;
  }

  create(input: NoticeInput, by: User): Notice {
    const clean = validate(input, true);
    const now = new Date().toISOString();
    const notice: Notice = {
      id: randomUUID(),
      kind: clean.kind!,
      title: clean.title!,
      body: clean.body ?? '',
      format: clean.format ?? 'html',
      ...(clean.version ? { version: clean.version } : {}),
      pinned: Boolean(clean.pinned),
      published: Boolean(clean.published),
      ...(clean.published ? { publishedAt: now } : {}),
      createdAt: now,
      createdBy: by.login,
      updatedAt: now,
      updatedBy: by.login,
      revisions: [],
    };
    putJson(this.storage, noticeKey(notice.id), notice);
    return notice;
  }

  update(id: string, input: NoticeInput, by: User): Notice {
    const old = this.require(id);
    const oldFormat = old.format ?? 'markdown';
    const clean = validate({ ...old, format: oldFormat, ...input, version: input.version === undefined ? old.version : input.version }, false);
    const contentChanged = clean.title !== old.title || clean.body !== old.body || clean.format !== oldFormat || clean.kind !== old.kind || (clean.version ?? undefined) !== old.version || Boolean(clean.pinned) !== old.pinned;
    const revision: NoticeRevision = { at: old.updatedAt, by: old.updatedBy, title: old.title, body: old.body, format: oldFormat, kind: old.kind, ...(old.version ? { version: old.version } : {}), pinned: old.pinned };
    const now = new Date().toISOString();
    const next: Notice = {
      ...old,
      kind: clean.kind!,
      title: clean.title!,
      body: clean.body ?? '',
      format: clean.format,
      pinned: Boolean(clean.pinned),
      published: Boolean(clean.published),
      // 처음 게시할 때의 시각 (내렸다 다시 올리면 새로 올린 시각)
      publishedAt: clean.published ? (old.published ? old.publishedAt : now) : undefined,
      updatedAt: now,
      updatedBy: by.login,
      revisions: contentChanged ? [revision, ...old.revisions].slice(0, MAX_REVISIONS) : old.revisions,
    };
    if (clean.version) next.version = clean.version;
    else delete next.version;
    if (!next.publishedAt) delete next.publishedAt;
    putJson(this.storage, noticeKey(id), next);
    return next;
  }

  /** 예전 내용으로 되돌리기 (지금 내용은 이력에 남는다) */
  restore(id: string, at: string, by: User): Notice {
    const old = this.require(id);
    const rev = old.revisions.find((r) => r.at === at);
    if (!rev) throw Object.assign(new Error('그 이력을 찾을 수 없습니다'), { statusCode: 404 });
    return this.update(id, { title: rev.title, body: rev.body, format: rev.format ?? 'markdown', kind: rev.kind, version: rev.version ?? null, pinned: rev.pinned }, by);
  }

  remove(id: string): void {
    this.require(id);
    this.storage.delete(noticeKey(id));
  }

  private require(id: string): Notice {
    const n = this.get(id);
    if (!n) throw Object.assign(new Error('글을 찾을 수 없습니다'), { statusCode: 404 });
    return n;
  }
}

function validate(input: NoticeInput, creating: boolean): NoticeInput {
  const fail = (m: string) => Object.assign(new Error(m), { statusCode: 400 });
  const kind = input.kind ?? (creating ? 'notice' : undefined);
  if (!kind || !NOTICE_KINDS.includes(kind)) throw fail('종류는 notice(공지)·web(웹 업데이트)·app(앱 업데이트) 중 하나입니다');
  const title = (input.title ?? '').trim();
  if (!title) throw fail('제목을 적어 주세요');
  if (title.length > 200) throw fail('제목은 200자까지입니다');
  const body = (input.body ?? '').replace(/\r\n/g, '\n');
  if (body.length > 100000) throw fail('내용이 너무 깁니다 (10만 자까지)');
  const format = input.format ?? 'html';
  if (format !== 'html' && format !== 'markdown') throw fail('형식은 html 또는 markdown입니다');
  const version = input.version?.trim().replace(/^v/i, '') || undefined;
  if (kind === 'app' && !version) throw fail('앱 업데이트 글에는 버전(예: 0.2.9)을 적어 주세요');
  if (version && !/^\d+\.\d+\.\d+$/.test(version)) throw fail('버전은 0.2.9 같은 모양으로 적어 주세요');
  return { kind, title, body, format, version: kind === 'app' ? version : undefined, pinned: Boolean(input.pinned), published: Boolean(input.published) };
}
