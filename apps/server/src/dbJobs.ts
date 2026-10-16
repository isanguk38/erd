// AI(MCP)가 요청한 DB 작업을 사용자의 앱(설치형 앱·로컬 화면)에 넘겨 처리한다.
// 웹 서비스 서버는 사용자 PC·사내망의 DB에 접속할 수 없어서, DB 연결 만들기·고치기·확인·DB로 내보내기는
// 그 사용자가 열어 둔 앱이 가져가(claim) 실행하고 결과를 돌려준다. 작업은 요청한 사람의 앱만 가져갈 수 있다.
// 메모리에만 둔다 (비밀번호가 들어 있을 수 있어 파일에 쓰지 않고, 앱이 가져가면 바로 지운다).

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

export type DbJobKind = 'listConnections' | 'saveConnection' | 'testConnection' | 'push' | 'pull' | 'compare' | 'seed';
export type DbJobStatus = 'pending' | 'running' | 'waiting_approval' | 'done' | 'failed';

export interface DbJob {
  id: string;
  userId: string;
  kind: DbJobKind;
  projectId?: string;
  payload: Record<string, unknown>;
  status: DbJobStatus;
  createdAt: number;
  updatedAt: number;
  result?: unknown;
  error?: string;
}

/** 앱이 이 시간 안에 가져가지 않으면 실패 (앱이 꺼져 있음) */
const PICKUP_MS = 20_000;
/** 앱이 가져간 뒤(승인 대기 포함) 이만큼 답이 없으면 실패 */
const STALE_MS = 15 * 60_000;
/** 끝난 작업은 이만큼 두었다가 지운다 */
const KEEP_MS = 30 * 60_000;
const DONE: DbJobStatus[] = ['done', 'failed'];

export const APP_NOT_OPEN = 'ERD 앱이 열려 있지 않아 DB 작업을 할 수 없습니다. 이 계정으로 로그인한 ERD 설치형 앱을 켜 두고 다시 요청하세요 (DB는 사용자 PC의 앱이 직접 접속합니다).';

export class DbJobQueue {
  private readonly jobs = new Map<string, DbJob>();
  private readonly events = new EventEmitter();

  /** pickupMs: 앱이 이 시간 안에 가져가지 않으면 실패 (테스트에서 줄인다) */
  constructor(private readonly pickupMs = PICKUP_MS) {
    this.events.setMaxListeners(0);
  }

  create(userId: string, kind: DbJobKind, payload: Record<string, unknown>, projectId?: string): DbJob {
    this.sweep();
    const now = Date.now();
    const job: DbJob = { id: randomUUID(), userId, kind, projectId, payload, status: 'pending', createdAt: now, updatedAt: now };
    this.jobs.set(job.id, job);
    this.events.emit(`user:${userId}`);
    // 앱이 가져가지 않으면 실패로
    setTimeout(() => {
      if (job.status === 'pending') this.finish(job, { status: 'failed', error: APP_NOT_OPEN });
    }, this.pickupMs).unref?.();
    return job;
  }

  get(userId: string, id: string): DbJob {
    const job = this.jobs.get(id);
    if (!job || job.userId !== userId) throw Object.assign(new Error('작업을 찾을 수 없습니다'), { statusCode: 404 });
    // 가져간 앱이 닫혀 답이 없으면 실패로 (승인 대기도 이만큼까지만)
    if (!DONE.includes(job.status) && job.status !== 'pending' && Date.now() - job.updatedAt > STALE_MS) this.finish(job, { status: 'failed', error: 'ERD 앱이 응답하지 않습니다 (작업 중에 앱이 닫혔거나 승인하지 않음). 다시 요청하세요' });
    return job;
  }

  /**
   * 앱이 다음 작업을 가져간다 (없으면 waitMs까지 기다림). 가져간 작업은 running이 된다.
   * signal: 앱의 요청이 끊기면(새로고침·창 닫기) 기다리기를 그만둔다 — 끊긴 요청에 작업을 넘겨 잃지 않게.
   * 비밀번호는 앱이 첫 진행 상황을 알릴 때 지운다 (그 전에 끊기면 release로 되돌려 다른 앱이 가져갈 수 있게).
   */
  async claim(userId: string, waitMs: number, signal?: AbortSignal): Promise<DbJob | null> {
    const take = () => {
      const job = [...this.jobs.values()].find((j) => j.userId === userId && j.status === 'pending');
      if (!job) return null;
      job.status = 'running';
      job.updatedAt = Date.now();
      this.events.emit(`job:${job.id}`);
      return { ...job };
    };
    const now = take();
    if (now || waitMs <= 0 || signal?.aborted) return now;
    return new Promise((resolve) => {
      const done = (job: DbJob | null) => {
        clearTimeout(timer);
        this.events.off(`user:${userId}`, onNew);
        signal?.removeEventListener('abort', onAbort);
        resolve(job);
      };
      const onNew = () => {
        const job = take();
        if (job) done(job);
      };
      const onAbort = () => done(null);
      const timer = setTimeout(() => done(null), waitMs);
      this.events.on(`user:${userId}`, onNew);
      signal?.addEventListener('abort', onAbort);
    });
  }

  /** 넘겨주려던 앱의 요청이 이미 끊겼으면 작업을 되돌린다 (다른 앱·다시 연 앱이 가져간다) */
  release(userId: string, id: string): void {
    const job = this.get(userId, id);
    if (job.status !== 'running') return;
    job.status = 'pending';
    job.updatedAt = Date.now();
    this.events.emit(`user:${userId}`);
  }

  /** 앱이 진행 상황·결과를 알린다 */
  update(userId: string, id: string, patch: { status: DbJobStatus; result?: unknown; error?: string }): DbJob {
    const job = this.get(userId, id);
    if (DONE.includes(job.status)) return job;
    // 앱이 받았으니 비밀번호는 서버에서 지운다
    job.payload = Object.fromEntries(Object.entries(job.payload).filter(([k]) => k !== 'password'));
    return this.finish(job, patch);
  }

  /** 끝나거나(waitMs 안에) 상태가 바뀔 때까지 기다린다. untilDone이면 승인 대기 중에도 계속 기다린다 */
  async wait(userId: string, id: string, waitMs: number): Promise<DbJob> {
    const job = this.get(userId, id);
    if (DONE.includes(job.status) || waitMs <= 0) return job;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.events.off(`job:${id}`, onChange);
        resolve(job);
      }, waitMs);
      const onChange = () => {
        if (!DONE.includes(job.status)) return;
        clearTimeout(timer);
        this.events.off(`job:${id}`, onChange);
        resolve(job);
      };
      this.events.on(`job:${id}`, onChange);
    });
  }

  private finish(job: DbJob, patch: { status: DbJobStatus; result?: unknown; error?: string }): DbJob {
    job.status = patch.status;
    if (patch.result !== undefined) job.result = patch.result;
    if (patch.error !== undefined) job.error = patch.error;
    if (DONE.includes(patch.status)) job.payload = Object.fromEntries(Object.entries(job.payload).filter(([k]) => k !== 'password'));
    job.updatedAt = Date.now();
    this.events.emit(`job:${job.id}`);
    return job;
  }

  private sweep() {
    const now = Date.now();
    for (const [id, job] of this.jobs) if (now - job.updatedAt > KEEP_MS) this.jobs.delete(id);
  }
}

/** 화면·AI에 돌려줄 모양 (비밀번호 등 요청 내용은 뺀다) */
export const publicJob = (job: DbJob) => ({ id: job.id, kind: job.kind, projectId: job.projectId, status: job.status, result: job.result, error: job.error, createdAt: new Date(job.createdAt).toISOString() });
