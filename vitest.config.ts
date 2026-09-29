import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (pkg: string) => fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    // Test against sources so `npm test` doesn't require a build first.
    alias: {
      '@costtrace/focus': src('focus'),
      '@costtrace/core': src('core'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
  },
});
