// 테스트 데이터를 화면과 다른 스레드에서 만든다 (테이블이 많아도 화면이 멈추지 않게). lib/seed.ts가 부른다.

import { generateSeedData, getDialect, type DialectId, type Schema, type SeedOptions } from '@erd/core';

self.onmessage = (e: MessageEvent<{ schema: Schema; dialect: DialectId; options: SeedOptions }>) => {
  const { schema, dialect, options } = e.data;
  try {
    self.postMessage({ ok: true, result: generateSeedData(schema, getDialect(dialect), options) });
  } catch (err) {
    self.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
