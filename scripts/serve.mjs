#!/usr/bin/env node
/** Self-hosting: serve apps/web/dist and the API from one Node process (`pnpm build && pnpm serve`). */
import { build } from 'esbuild';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { security } from './headers.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'apps/web/dist');
const bundle = join(root, 'node_modules/.cache/meridian-server.mjs');
await build({ entryPoints: [join(root, 'apps/server/src/node.ts')], bundle: true, platform: 'node', format: 'esm', outfile: bundle, logLevel: 'warning', banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" } });
const { default: api } = await import(pathToFileURL(bundle).href);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.woff2': 'font/woff2' };
const port = Number(process.env.PORT ?? 8787);
createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  for (const [k, v] of Object.entries(security)) if (k !== 'Strict-Transport-Security') res.setHeader(k, v);
  if (url.pathname.startsWith('/api/')) return api(req, res);
  let file = normalize(join(dist, decodeURIComponent(url.pathname)));
  if (!file.startsWith(dist) || !existsSync(file) || statSync(file).isDirectory()) file = join(dist, 'index.html');
  res.setHeader('Content-Type', TYPES[extname(file)] ?? 'application/octet-stream');
  if (file.includes('/assets/')) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  createReadStream(file).pipe(res);
}).listen(port, () => console.log(`Meridian Terminal on http://localhost:${port}`));
