import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { type Plugin, defineConfig, loadEnv } from 'vite';

/** Mounts the real API handlers (apps/server) on the dev server, so `pnpm dev` needs no extra process. */
function devApi(): Plugin {
  return {
    name: 'meridian-dev-api',
    configureServer(server) {
      const env = loadEnv('development', resolve(import.meta.dirname, '../..'), '');
      for (const [k, v] of Object.entries(env)) if (process.env[k] === undefined) process.env[k] = v;
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/api/')) return next();
        try {
          const mod = (await server.ssrLoadModule(resolve(import.meta.dirname, '../server/src/node.ts'))) as { default: (q: typeof req, s: typeof res) => Promise<void> };
          await mod.default(req, res);
        } catch (e) {
          next(e);
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), devApi()],
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('lightweight-charts') || id.includes('fancy-canvas')) return 'charts';
          if (id.includes('dockview')) return 'dock';
          if (id.includes('node_modules/react') || id.includes('scheduler')) return 'react';
          if (id.includes('radix-ui') || id.includes('@radix-ui')) return 'radix';
          return undefined;
        },
      },
    },
  },
  server: { port: 5173 },
});
