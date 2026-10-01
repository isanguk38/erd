#!/usr/bin/env node
// TypeScript 원본을 tsx로 실행한다
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const tsx = join(dirname(require.resolve('tsx/package.json')), 'dist', 'cli.mjs');
const child = spawn(process.execPath, [tsx, join(here, '..', 'src', 'stdio.ts')], { stdio: 'inherit', env: process.env });
child.on('exit', (code) => process.exit(code ?? 0));
