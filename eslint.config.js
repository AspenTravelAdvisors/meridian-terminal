import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '.vercel/**', '.turbo/**', 'coverage/**', 'playwright-report/**', 'test-results/**', 'apps/web/public/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      'no-constant-condition': ['error', { checkLoops: false }],
    },
  },
  {
    // the engine must stay deterministic: no wall clock or randomness (CLAUDE.md rule 4)
    files: ['packages/engine/src/**/*.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        { object: 'Date', property: 'now', message: 'Engine must be deterministic — no wall clock.' },
        { object: 'Math', property: 'random', message: 'Engine must be deterministic — use the seeded PRNG.' },
      ],
      'no-restricted-globals': ['error', { name: 'window', message: 'Engine has zero DOM dependencies.' }, { name: 'document', message: 'Engine has zero DOM dependencies.' }],
    },
  },
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
);
