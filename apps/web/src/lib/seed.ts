// 테스트 데이터 만들기를 백그라운드(Web Worker)에서: 큰 ERD에서도 화면이 멈추지 않고, 너무 오래 걸리면 멈춘다.
// 테스트 데이터 창(SeedDialog)과 AI의 테스트 데이터 넣기(aiDbJobs)가 함께 쓴다.

import { generateSeedData, getDialect, type DialectId, type Schema, type SeedOptions, type SeedResult } from '@erd/core';

/** 이보다 오래 걸리면 멈추고 알린다 */
const TIME_LIMIT_MS = 60_000;

export interface SeedRun {
  promise: Promise<SeedResult>;
  /** 다른 설정으로 다시 만들 때 앞의 것을 버린다 */
  cancel: () => void;
}

export function runSeedData(schema: Schema, dialect: DialectId, options: SeedOptions): SeedRun {
  if (typeof Worker === 'undefined') {
    // 워커를 쓸 수 없는 환경이면 그 자리에서 (테스트 등)
    return { promise: new Promise((resolve) => setTimeout(() => resolve(generateSeedData(schema, getDialect(dialect), options)), 0)), cancel: () => {} };
  }
  const worker = new Worker(new URL('./seedWorker.ts', import.meta.url), { type: 'module' });
  let settle: ((r: SeedResult) => void) | null = null;
  let fail: ((e: Error) => void) | null = null;
  const promise = new Promise<SeedResult>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  const timer = setTimeout(() => {
    worker.terminate();
    fail?.(new Error(`테스트 데이터를 ${TIME_LIMIT_MS / 1000}초 안에 만들지 못해 멈췄습니다. 테이블이나 행 수를 줄여 다시 해 보세요`));
  }, TIME_LIMIT_MS);
  worker.onmessage = (e: MessageEvent<{ ok: boolean; result?: SeedResult; error?: string }>) => {
    clearTimeout(timer);
    worker.terminate();
    if (e.data.ok) settle?.(e.data.result!);
    else fail?.(new Error(e.data.error ?? '테스트 데이터를 만들지 못했습니다'));
  };
  worker.onerror = (e) => {
    clearTimeout(timer);
    worker.terminate();
    fail?.(new Error(e.message || '테스트 데이터를 만들지 못했습니다'));
  };
  worker.postMessage({ schema, dialect, options });
  return {
    promise,
    cancel: () => {
      clearTimeout(timer);
      worker.terminate();
    },
  };
}
