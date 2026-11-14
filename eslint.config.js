import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      // stdout belongs to the MCP protocol; log to stderr instead.
      'no-console': ['error', { allow: ['error'] }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // The CLI writes its report to stdout; it never runs inside the server.
    files: ['src/cli/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
);
