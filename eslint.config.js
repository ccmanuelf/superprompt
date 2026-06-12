// Minimal, high-signal ESLint config (rc.113). Philosophy: every rule here
// must catch real bugs or real drift; style nits are left to Prettier (not
// CI-gated to avoid a big-bang reformat of 60k+ existing lines).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', 'scripts/', 'docs/', 'workspace/', 'store/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    rules: {
      // tsc strict mode already covers type errors; these add bug-catching
      // signal on top.
      'no-fallthrough': 'error',
      'no-template-curly-in-string': 'error',
      'require-atomic-updates': 'off', // too many false positives on hot paths
      '@typescript-eslint/no-floating-promises': 'off', // needs type-aware linting; revisit
      '@typescript-eslint/no-explicit-any': 'warn', // 26 legacy usages — ratchet down, don't block
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      // ESM project — require() in source is the exact bug class the dist
      // smoke test exists for (rc.92 incident); make it a lint error too.
      '@typescript-eslint/no-require-imports': 'error',
    },
  },
  {
    // Tests mock aggressively; relax rules that fight established idioms.
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
