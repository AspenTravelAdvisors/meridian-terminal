import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/*/test/**/*.test.ts', 'apps/server/test/**/*.test.ts', 'apps/web/test/**/*.test.ts'],
          exclude: ['**/*.golden.test.ts'],
        },
      },
      { test: { name: 'golden', include: ['packages/*/test/**/*.golden.test.ts'] } },
    ],
    coverage: { provider: 'v8', include: ['packages/engine/src/**'], reporter: ['text-summary', 'html'] },
  },
});
