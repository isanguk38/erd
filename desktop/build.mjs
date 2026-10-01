// 앱 코드를 한 파일로 묶는다. DB 연결 코드는 저장소의 packages/db, packages/core를 그대로 쓴다.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: false,
  external: ['electron', 'pg-native', 'pg-cloudflare', 'cloudflare:sockets'],
  alias: {
    '@erd/core': `${root}packages/core/src/index.ts`,
    '@erd/db': `${root}packages/db/src/index.ts`,
  },
  // 저장소 루트의 node_modules(mysql2, pg, yjs 등)를 쓴다
  nodePaths: [`${root}node_modules`],
  logLevel: 'info',
};

await build({ ...common, entryPoints: ['src/main.ts'], outfile: 'dist/main.cjs' });
await build({ ...common, entryPoints: ['src/preload.ts'], outfile: 'dist/preload.cjs' });
