import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['.relay-data/**', 'artifacts/**', 'dist/**', 'node_modules/**', 'outputs/**', 'work/**', 'integrations/hermes/runtime/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['integrations/hermes/*.mjs'],
    languageOptions: { globals: { fetch: 'readonly', AbortSignal: 'readonly' } }
  },
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': 'off'
    }
  }
);
