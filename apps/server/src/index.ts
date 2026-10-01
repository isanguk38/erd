import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app';

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.ERD_SERVER_PORT || 4000);
// 이 서버는 DB 접속 정보를 다루므로 기본은 내 PC에서만 접속 가능하게 연다.
const host = process.env.ERD_SERVER_HOST || '127.0.0.1';

const app = buildApp({
  dataDir: process.env.ERD_DATA_DIR || resolve(here, '../data'),
  secret: process.env.ERD_SECRET,
  logger: true,
});

app.listen({ port, host }).catch((e) => {
  console.error(e);
  process.exit(1);
});
