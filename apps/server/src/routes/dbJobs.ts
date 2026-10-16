// AI(MCP)가 요청한 DB 작업 ↔ 사용자의 앱 (dbJobs.ts)
//   POST /api/db-jobs              AI: 작업 만들기 (끝날 때까지 wait초 기다림)
//   GET  /api/db-jobs/next         앱: 내 다음 작업 가져가기 (롱폴링)
//   POST /api/db-jobs/:id          앱: 진행 상황·결과 알리기
//   GET  /api/db-jobs/:id          AI: 결과 확인 (wait초 기다림)

import type { FastifyInstance } from 'fastify';
import { atLeast, type Auth } from '../auth';
import { publicJob, type DbJobKind, type DbJobQueue, type DbJobStatus } from '../dbJobs';

const KINDS: DbJobKind[] = ['listConnections', 'saveConnection', 'testConnection', 'push', 'pull', 'compare', 'seed'];
const STATUSES: DbJobStatus[] = ['running', 'waiting_approval', 'done', 'failed'];
/** 한 번 요청에서 기다리는 최대 시간 (MCP 클라이언트가 먼저 끊지 않게) */
const MAX_WAIT_S = 110;
const seconds = (v: unknown, fallback: number) => Math.min(MAX_WAIT_S, Math.max(0, Number(v ?? fallback) || 0)) * 1000;

export function registerDbJobRoutes(app: FastifyInstance, queue: DbJobQueue, auth: Auth) {
  app.post<{ Body: { kind: DbJobKind; projectId?: string; payload?: Record<string, unknown>; wait?: number } }>('/api/db-jobs', async (req) => {
    const { kind, projectId, payload = {}, wait } = req.body ?? ({} as never);
    if (!KINDS.includes(kind)) throw Object.assign(new Error(`kind는 ${KINDS.join(', ')} 중 하나입니다`), { statusCode: 400 });
    if (projectId && !atLeast(auth.role(projectId, req.user.id), 'editor')) throw Object.assign(new Error('이 프로젝트를 편집할 권한이 없습니다'), { statusCode: 403 });
    const job = queue.create(req.user.id, kind, payload, projectId);
    return publicJob(await queue.wait(req.user.id, job.id, seconds(wait, 60)));
  });

  app.get<{ Querystring: { wait?: string } }>('/api/db-jobs/next', async (req, reply) => {
    // 앱이 새로고침·종료로 요청을 끊으면(답하기 전에 연결이 닫힘) 기다리기를 그만두고, 이미 넘기려던 작업은 되돌린다
    const abort = new AbortController();
    const onClose = () => {
      if (!reply.raw.writableEnded) abort.abort();
    };
    reply.raw.once('close', onClose);
    try {
      const job = await queue.claim(req.user.id, seconds(req.query.wait, 25), abort.signal);
      if (job && abort.signal.aborted) {
        queue.release(req.user.id, job.id);
        return { job: null };
      }
      return { job: job ? { id: job.id, kind: job.kind, projectId: job.projectId, payload: job.payload } : null };
    } finally {
      reply.raw.off('close', onClose);
    }
  });

  app.post<{ Params: { id: string }; Body: { status: DbJobStatus; result?: unknown; error?: string } }>('/api/db-jobs/:id', async (req) => {
    const { status, result, error } = req.body ?? ({} as never);
    if (!STATUSES.includes(status)) throw Object.assign(new Error('잘못된 상태입니다'), { statusCode: 400 });
    return publicJob(queue.update(req.user.id, req.params.id, { status, result, error: typeof error === 'string' ? error.slice(0, 4000) : undefined }));
  });

  app.get<{ Params: { id: string }; Querystring: { wait?: string } }>('/api/db-jobs/:id', async (req) => publicJob(await queue.wait(req.user.id, req.params.id, seconds(req.query.wait, 0))));
}
