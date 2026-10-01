// ERD 서버 실행.
//
// 로컬 모드 (기본): 아무 설정 없이 npm run dev. 127.0.0.1에서만 열리고, 데이터는 apps/server/data에 저장.
// 배포 모드: 아래 환경 변수를 설정한다 (render.yaml 참고).
//   DATABASE_URL          저장할 PostgreSQL (예: Supabase). 없으면 파일에 저장
//   ERD_SECRET            DB 비밀번호 암호화·세션 서명 키 (배포 시 필수, 바꾸면 저장된 DB 비밀번호를 못 읽음)
//   ERD_PUBLIC_URL        외부 주소 (예: https://erd.onrender.com)
//   GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET   GitHub 로그인 (OAuth App 콜백: <ERD_PUBLIC_URL>/auth/github/callback)
//   ERD_ALLOW_PRIVATE_DB  1이면 로그인 모드에서도 내부망 주소의 DB 연결 허용 (기본 금지)
//   PORT                  포트 (NODE_ENV=production일 때, Render가 지정)

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { buildApp } from './app';
import { FileStorage, PostgresStorage, type Storage } from './storage';

const here = dirname(fileURLToPath(import.meta.url));
const env = process.env;

const github = env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET ? { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET } : undefined;
const devLogin = env.ERD_DEV_LOGIN === '1' && env.NODE_ENV !== 'production';
const authEnabled = Boolean(github || devLogin);
const publicUrl = env.ERD_PUBLIC_URL || env.ERD_WEB_URL || 'http://localhost:5173';

function fail(message: string): never {
  console.error(`\n[ERD 서버 설정 오류] ${message}\n`);
  process.exit(1);
}

if (env.NODE_ENV === 'production' && !authEnabled) {
  fail('배포(NODE_ENV=production)에서는 로그인이 꼭 필요합니다. GITHUB_CLIENT_ID와 GITHUB_CLIENT_SECRET을 설정하세요.');
}
if ((authEnabled || env.DATABASE_URL) && !env.ERD_SECRET) {
  fail('로그인 모드나 DATABASE_URL을 쓸 때는 ERD_SECRET(긴 임의 문자열)을 꼭 설정해야 합니다.');
}

async function openStorage(): Promise<Storage> {
  if (!env.DATABASE_URL) return new FileStorage(env.ERD_DATA_DIR || resolve(here, '../data'));
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(env.DATABASE_URL);
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL, ssl: local ? undefined : { rejectUnauthorized: false }, max: 4 });
  return PostgresStorage.open(pool, () => pool.end());
}

const storage = await openStorage();
// PORT는 배포 환경(Render 등)이 정해 주는 값이다. 로컬 개발에서는 화면 개발 서버와 겹치지 않게 ERD_SERVER_PORT(기본 4000)를 쓴다.
const port = Number(env.ERD_SERVER_PORT || (env.NODE_ENV === 'production' ? env.PORT : undefined) || 4000);
// 로컬 모드는 DB 접속 정보를 다루므로 내 PC에서만 연다. 배포(로그인 모드)는 외부에 연다.
const host = env.ERD_SERVER_HOST || (authEnabled ? '0.0.0.0' : '127.0.0.1');
const staticDir = resolve(here, '../../web/dist');

const { app, mcpToken, auth } = buildApp({
  storage,
  secret: env.ERD_SECRET,
  mcpToken: env.ERD_MCP_TOKEN,
  webUrl: publicUrl,
  auth: authEnabled ? { enabled: true, github, devLogin, allowPrivateDb: env.ERD_ALLOW_PRIVATE_DB === '1' } : undefined,
  staticDir: env.NODE_ENV === 'production' || env.ERD_SERVE_WEB === '1' ? staticDir : undefined,
});

// 종료할 때 메모리의 문서를 저장한다
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    app
      .close()
      .then(() => storage.close())
      .finally(() => process.exit(0));
  });
}

app
  .listen({ port, host })
  .then(() => {
    console.log(`ERD 서버: http://${host}:${port}  (저장: ${storage.kind === 'postgres' ? 'PostgreSQL' : '파일'}, ${auth.enabled ? `로그인 모드: ${[github && 'GitHub', devLogin && '개발용'].filter(Boolean).join(', ')}` : '로컬 모드'})`);
    if (!auth.enabled) console.log(`원격 MCP: http://${host}:${port}/mcp  (토큰: ${mcpToken.slice(0, 8)}… / 전체는 화면의 AI 버튼)`);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
