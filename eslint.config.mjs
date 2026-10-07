import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/node_modules/**', '**/dist/**', '**/.vitepress/dist/**', '**/.vitepress/cache/**', '**/.wrangler/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    files: ['**/*.ts', '**/*.mts'],
    rules: {
      'no-console': ['error', { allow: ['error'] }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', ignoreRestSiblings: true }],
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    // The CLI prints to the terminal by design.
    files: ['packages/cli/src/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['**/*.mjs', '**/*.js'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly', URL: 'readonly', Response: 'readonly', Buffer: 'readonly' },
    },
  },
);
