import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const pkg = (name: string) => path.resolve(rootDir, 'packages', name, 'src', 'index.ts');

export default defineConfig({
  resolve: {
    alias: {
      '@jobhelper/contracts': pkg('contracts'),
      '@jobhelper/storage': pkg('storage'),
      '@jobhelper/core': pkg('core'),
      '@jobhelper/model-router': pkg('model-router'),
      '@jobhelper/browser-bridge': pkg('browser-bridge'),
      '@jobhelper/tools': pkg('tools'),
      '@jobhelper/skills': pkg('skills'),
      '@jobhelper/runtime': pkg('runtime'),
      '@jobhelper/mcp-adapter': pkg('mcp-adapter'),
    },
  },
  test: {
    environment: 'node',
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    testTimeout: 15_000,
    hookTimeout: 15_000,
    reporters: ['default'],
  },
});
