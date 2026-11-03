// 프로젝트 그룹 API: 내 그룹만 보고 만들고 고친다 (그룹에는 권한이 없고, 공유는 프로젝트 단위).

import type { FastifyInstance } from 'fastify';
import type { GroupStore } from '../groups';
import type { ProjectStore } from '../projects';

export function registerGroupRoutes(app: FastifyInstance, groups: GroupStore, projects: ProjectStore) {
  app.get('/api/groups', async (req) => groups.list(req.user.id));
  app.post<{ Body: { name?: string; parentId?: string | null; color?: string | null } }>('/api/groups', async (req) => groups.create(req.body ?? {}, req.user.id));
  app.patch<{ Params: { gid: string }; Body: { name?: string; parentId?: string | null; color?: string | null } }>('/api/groups/:gid', async (req) =>
    groups.update(req.params.gid, req.body ?? {}, req.user.id),
  );
  app.delete<{ Params: { gid: string } }>('/api/groups/:gid', async (req) => {
    groups.remove(req.params.gid, req.user.id, projects.list().map((p) => p.id));
    return { ok: true };
  });
}
