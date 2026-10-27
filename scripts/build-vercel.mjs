#!/usr/bin/env node
/**
 * Emits a Vercel Build Output API v3 tree (.vercel/output) so the deployment is fully deterministic:
 *   static/          ← apps/web/dist (Vite build)
 *   functions/api.func  ← one bundled Node function serving every /api/* route (apps/server)
 *   config.json      ← routing: immutable assets, filesystem, /api → function, SPA fallback, security headers
 * Vercel picks up .vercel/output automatically when the build command produces it.
 */
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { security } from './headers.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, '.vercel/output');
const web = join(root, 'apps/web/dist');
if (!existsSync(join(web, 'index.html'))) {
  console.error('apps/web/dist is missing — run `pnpm build` first');
  process.exit(1);
}
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'static'), { recursive: true });
cpSync(web, join(out, 'static'), { recursive: true });

const fn = join(out, 'functions/api.func');
mkdirSync(fn, { recursive: true });
await build({
  stdin: {
    contents: "const h = require('./apps/server/src/node.ts').default; module.exports = h; module.exports.default = h;",
    resolveDir: root,
    sourcefile: 'vercel-entry.cjs',
    loader: 'js',
  },
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: join(fn, 'index.js'),
  sourcemap: 'linked',
  minify: true,
  legalComments: 'none',
  // embedded Postgres is only for local dev / self-hosting; on Vercel the database is DATABASE_URL (Neon)
  external: ['@electric-sql/pglite', 'drizzle-orm/pglite'],
  logLevel: 'warning',
});
writeFileSync(join(fn, 'package.json'), JSON.stringify({ type: 'commonjs' }));
writeFileSync(
  join(fn, '.vc-config.json'),
  JSON.stringify({ runtime: 'nodejs22.x', handler: 'index.js', launcherType: 'Nodejs', shouldAddHelpers: false, supportsResponseStreaming: true, maxDuration: 60 }, null, 2),
);



// Background alerts. Vercel Hobby allows one cron run per day (more frequent schedules fail the deployment), so the
// default is daily; on Pro set ALERT_CRON_SCHEDULE="* * * * *" or point any external scheduler at /api/cron/alerts.
const alertCron = process.env.ALERT_CRON_SCHEDULE || '7 21 * * *';

writeFileSync(
  join(out, 'config.json'),
  JSON.stringify(
    {
      version: 3,
      crons: alertCron === 'off' ? [] : [{ path: '/api/cron/alerts', schedule: alertCron }],
      routes: [
        { src: '/(.*)', headers: security, continue: true },
        { src: '/assets/(.*)', headers: { 'Cache-Control': 'public, max-age=31536000, immutable' }, continue: true },
        { src: '/(sw\\.js|manifest\\.webmanifest)', headers: { 'Cache-Control': 'no-cache' }, continue: true },
        { handle: 'filesystem' },
        { src: '/api/(.*)', dest: '/api' },
        { src: '/(.*)', dest: '/index.html' },
      ],
    },
    null,
    2,
  ),
);
console.log('✓ .vercel/output ready (static + functions/api.func)');
