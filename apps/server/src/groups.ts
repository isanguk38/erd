// 프로젝트 그룹 (GitLab의 그룹처럼 폴더 역할, 그룹 안에 하위 그룹도).
// 그룹은 만든 사람만의 정리 공간이라 권한이 없다: 공유는 지금처럼 프로젝트 단위로만 하고,
// 공유받은 사람에게는 그 프로젝트가 들어 있는 그룹 경로(이름)만 보이고 같은 그룹의 다른 프로젝트는 보이지 않는다.
// 프로젝트를 어느 그룹에 둘지는 프로젝트 소유자만 정한다 (group-of/<프로젝트 id>).

import { randomUUID } from 'node:crypto';
import { getJson, putJson, type Storage } from './storage';

export interface Group {
  id: string;
  name: string;
  /** 위 그룹 (없으면 맨 위) */
  parentId: string | null;
  /** 폴더 색 (#rrggbb, 없으면 기본색) */
  color?: string;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
}

export interface GroupPathItem {
  id: string;
  name: string;
  color?: string;
}

const groupKey = (id: string) => `groups/${id}.json`;
const placeKey = (projectId: string) => `group-of/${projectId}.json`;
const MAX_DEPTH = 10;
const fail = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode });

export class GroupStore {
  constructor(private readonly storage: Storage) {}

  private all(): Group[] {
    return this.storage
      .keys('groups/')
      .map((k) => getJson<Group | null>(this.storage, k, null))
      .filter((g): g is Group => Boolean(g?.id));
  }

  get(id: string): Group | null {
    return getJson<Group | null>(this.storage, groupKey(id), null);
  }

  /** 내 그룹 (이름순) */
  list(ownerId: string): Group[] {
    return this.all()
      .filter((g) => g.ownerId === ownerId)
      .sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  }

  /** 내 그룹이어야 고칠 수 있다 (남의 그룹은 없는 것처럼) */
  private mine(id: string, ownerId: string): Group {
    const g = this.get(id);
    if (!g || g.ownerId !== ownerId) throw fail('그룹을 찾을 수 없습니다', 404);
    return g;
  }

  private cleanName(name: unknown): string {
    const n = typeof name === 'string' ? name.trim() : '';
    if (!n) throw fail('그룹 이름을 적어 주세요');
    if (n.length > 100) throw fail('그룹 이름은 100자까지입니다');
    return n;
  }

  /** 색: #rrggbb, null·빈 값이면 기본색으로 */
  private cleanColor(color: unknown): string | undefined {
    if (color === null || color === '') return undefined;
    if (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) throw fail('색은 #rrggbb 형식이어야 합니다');
    return color.toLowerCase();
  }

  private depth(id: string | null): number {
    let d = 0;
    for (let g = id ? this.get(id) : null; g; g = g.parentId ? this.get(g.parentId) : null) d++;
    return d;
  }

  create(input: { name?: unknown; parentId?: unknown; color?: unknown }, ownerId: string): Group {
    const parentId = typeof input.parentId === 'string' && input.parentId ? this.mine(input.parentId, ownerId).id : null;
    if (this.depth(parentId) >= MAX_DEPTH) throw fail(`그룹은 ${MAX_DEPTH}단계까지 만들 수 있습니다`);
    const name = this.cleanName(input.name);
    if (this.list(ownerId).some((g) => g.parentId === parentId && g.name === name)) throw fail(`같은 곳에 "${name}" 그룹이 이미 있습니다`);
    const now = new Date().toISOString();
    const color = input.color === undefined ? undefined : this.cleanColor(input.color);
    const group: Group = { id: randomUUID(), name, parentId, ...(color ? { color } : {}), ownerId, createdAt: now, updatedAt: now };
    putJson(this.storage, groupKey(group.id), group);
    return group;
  }

  /** 이름 바꾸기·옮기기 (자기 자신이나 하위 그룹 안으로는 못 옮김) */
  update(id: string, input: { name?: unknown; parentId?: unknown; color?: unknown }, ownerId: string): Group {
    const g = this.mine(id, ownerId);
    const next = { ...g };
    if (input.name !== undefined) next.name = this.cleanName(input.name);
    if (input.color !== undefined) {
      const color = this.cleanColor(input.color);
      if (color) next.color = color;
      else delete next.color;
    }
    if (input.parentId !== undefined) {
      const parentId = typeof input.parentId === 'string' && input.parentId ? this.mine(input.parentId, ownerId).id : null;
      for (let p = parentId ? this.get(parentId) : null; p; p = p.parentId ? this.get(p.parentId) : null) {
        if (p.id === id) throw fail('그룹을 자기 자신이나 하위 그룹 안으로 옮길 수 없습니다');
      }
      if (this.depth(parentId) + this.height(id) > MAX_DEPTH) throw fail(`그룹은 ${MAX_DEPTH}단계까지 만들 수 있습니다`);
      next.parentId = parentId;
    }
    if (this.list(ownerId).some((o) => o.id !== id && o.parentId === next.parentId && o.name === next.name)) throw fail(`같은 곳에 "${next.name}" 그룹이 이미 있습니다`);
    next.updatedAt = new Date().toISOString();
    putJson(this.storage, groupKey(id), next);
    return next;
  }

  /** 이 그룹과 그 아래 단계 수 (옮길 때 깊이 확인) */
  private height(id: string): number {
    const children = this.all().filter((g) => g.parentId === id);
    return 1 + Math.max(0, ...children.map((c) => this.height(c.id)));
  }

  /** 비어 있을 때만 지운다 (하위 그룹·프로젝트가 있으면 먼저 옮기거나 지우도록) */
  remove(id: string, ownerId: string, projectIds: string[]): void {
    this.mine(id, ownerId);
    const subgroups = this.all().filter((g) => g.parentId === id).length;
    const projects = projectIds.filter((p) => this.groupOf(p) === id).length;
    if (subgroups || projects) {
      const parts = [subgroups && `하위 그룹 ${subgroups}개`, projects && `프로젝트 ${projects}개`].filter(Boolean).join('·');
      throw fail(`그룹 안에 ${parts}가 있어 지울 수 없습니다. 먼저 다른 곳으로 옮기거나 지워 주세요`);
    }
    this.storage.delete(groupKey(id));
  }

  // ── 프로젝트 자리 ─────────────────────────────

  groupOf(projectId: string): string | null {
    const id = getJson<{ groupId: string | null } | null>(this.storage, placeKey(projectId), null)?.groupId ?? null;
    return id && this.get(id) ? id : null;
  }

  /** 프로젝트를 그룹에 둔다 (null이면 맨 위). 그룹은 프로젝트 소유자의 것이어야 한다 */
  place(projectId: string, groupId: string | null, ownerId: string): void {
    if (groupId) this.mine(groupId, ownerId);
    if (groupId) putJson(this.storage, placeKey(projectId), { groupId });
    else this.storage.delete(placeKey(projectId));
  }

  forget(projectId: string): void {
    this.storage.delete(placeKey(projectId));
  }

  /** 프로젝트가 든 그룹 경로 (맨 위 → 바로 위 그룹) */
  pathOf(projectId: string): GroupPathItem[] {
    const path: GroupPathItem[] = [];
    for (let g = this.get(this.groupOf(projectId) ?? ''); g && path.length < MAX_DEPTH + 1; g = g.parentId ? this.get(g.parentId) : null) {
      path.unshift({ id: g.id, name: g.name, ...(g.color ? { color: g.color } : {}) });
    }
    return path;
  }
}
