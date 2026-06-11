import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    include: ['tests/**/*.test.ts'],
    testTimeout: 10_000,
    hookTimeout: 10_000,
    coverage: {
      provider: 'v8',
      include: [
        'src/env.ts',
        'src/db-core.ts',
        'src/db-knex.ts',
        'src/db-dialect.ts',
        'src/memory.ts',
        'src/config.ts',
        'src/media.ts',
        'src/scheduler.ts',
        'src/embeddings.ts',
        'src/files.ts',
        'src/docgen.ts',
        'src/skills.ts',
        'src/platforms/telegram.ts',
        'src/platforms/matrix.ts',
        'src/providers/**/*.ts',
        'src/core/**/*.ts',
        'src/ipc/**/*.ts',
        'src/web/**/*.ts',
        'src/policy-engine.ts',
      ],
    },
  },
});
