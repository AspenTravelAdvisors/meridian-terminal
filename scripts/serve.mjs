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
// bundled next to apps/server's own node_modules so the external embedded-Postgres package resolves at runtime
const bundle = join(root, 'apps/server/node_modules/.cache/meridian-server.mjs');
await build({ entryPoints: [join(root, 'apps/server/src/node.ts')], bundle: true, platform: 'node', format: 'esm', outfile: bundle, logLevel: 'warning', external: ['@electric-sql/pglite', 'drizzle-orm/pglite'], banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" } });
const { default: api } = await import(pathToFileURL(bundle).href);
const gateBundle = join(root, 'node_modules/.cache/meridian-gate.mjs');
await build({ entryPoints: [join(root, 'apps/server/src/gate.ts')], bundle: true, platform: 'node', format: 'esm', outfile: gateBundle, logLevel: 'warning' });
const { gate, LOGIN_PATH } = await import(pathToFileURL(gateBundle).href);

const localSecurity = Object.fromEntries(Object.entries(security).filter(([k]) => k !== 'Strict-Transport-Security'));

/** Password gate (apps/server/src/gate.ts), active when SITE_PASSWORD is set. Returns true when it answered. */
async function gated(req, res) {
  if (!process.env.SITE_PASSWORD) return false;
  const url = `http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
  let body;
  if (req.method === 'POST' && new URL(url).pathname === LOGIN_PATH) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    body = Buffer.concat(chunks);
  }
  const r = await gate(new Request(url, { method: req.method, headers, body }), { SITE_PASSWORD: process.env.SITE_PASSWORD, CRON_SECRET: process.env.CRON_SECRET }, { required: false, headers: localSecurity });
  if (!r) return false;
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
  return true;
}
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.woff2': 'font/woff2' };
const port = Number(process.env.PORT ?? 8787);
createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (await gated(req, res)) return;
  for (const [k, v] of Object.entries(security)) if (k !== 'Strict-Transport-Security') res.setHeader(k, v);
  if (url.pathname.startsWith('/api/')) return api(req, res);
  let file = normalize(join(dist, decodeURIComponent(url.pathname)));
  if (!file.startsWith(dist) || !existsSync(file) || statSync(file).isDirectory()) file = join(dist, 'index.html');
  res.setHeader('Content-Type', TYPES[extname(file)] ?? 'application/octet-stream');
  if (file.includes('/assets/')) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  createReadStream(file).pipe(res);
}).listen(port, () => console.log(`Meridian Terminal on http://localhost:${port}`));
