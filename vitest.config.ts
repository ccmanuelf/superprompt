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
        'src/db.ts',
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
      ],
    },
  },
});
