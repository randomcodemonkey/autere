import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist/', 'dist-backend/', 'node_modules/', 'coverage/', 'cypress/screenshots/', 'cypress/videos/', 'cypress/downloads/', 'tui/dist/', 'tui/node_modules/', 'tui/smoke/out/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // React 18 app, not on React Compiler: these compiler-era rules flag
      // deliberate patterns here (latest-value refs for SSE state, sync
      // setState in fetch effects). Revisit if/when adopting the compiler.
      'react-hooks/refs': 'off',
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/immutability': 'off',
      'react-hooks/purity': 'off',
      'react-hooks/preserve-manual-memoization': 'off',
      // Backend uses `any` heavily at RPC boundaries (pi event payloads)
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      // `try {} catch {}` best-effort blocks are an established pattern here
      // (SSE writes, optional cleanup) — flag only genuinely empty blocks
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    // Cypress: chai's `expect(x).to.deep.equal(y)` uses property access for
    // readability; `declare namespace Cypress` is the official augmentation
    files: ['cypress/**/*.cy.ts', 'cypress/**/*.cy.tsx', 'cypress/e2e/**/*.ts', 'cypress/component/support/**/*.ts', 'cypress/e2e/support/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-expressions': 'off',
      '@typescript-eslint/no-namespace': 'off',
    },
  },
);
