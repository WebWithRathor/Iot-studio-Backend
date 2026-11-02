// @ts-check
const js = require('@eslint/js');
const tseslint = require('typescript-eslint');
const globals = require('globals');

module.exports = tseslint.config(
  { ignores: ['dist/**', 'logs/**', 'node_modules/**', 'types-offline/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': ['warn', { allow: ['error'] }],
      // Architecture guard: controllers must not touch models or DAOs directly.
      'no-restricted-imports': 'off',
    },
  },
  {
    files: ['src/controllers/**/*.ts', 'src/routes/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{ group: ['**/models/*', '**/dao/*', 'mongoose'], message: 'Controllers and routes must go through services (no models/DAOs/mongoose).' }] }],
    },
  },
  {
    files: ['src/routes/public/**/*.ts', 'src/controllers/public/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{ group: ['**/controllers/private/*', '**/services/private/*', '**/validations/private/*', '**/models/*', '**/dao/*', 'mongoose'], message: 'Public layers must not import private (admin) layers or the database.' }] }],
    },
  },
  {
    files: ['scripts/**/*.ts', 'tests/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
);
