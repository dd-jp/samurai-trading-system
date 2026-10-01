import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@contracts': fileURLToPath(new URL('./contracts/index.ts', import.meta.url)),
    },
  },
  plugins: [react({ include: /client\/.+\.tsx$/ })],
  test: {
    include: [
      'server/**/*.test.ts',
      'contracts/**/*.test.ts',
      'client/**/*.test.ts',
      'client/**/*.test.tsx',
    ],
    environment: 'node',
    globals: true,
    globalSetup: ['./vitest.global-setup.ts'],
    setupFiles: ['./vitest.setup.ts'],
    reporters: ['default', ['junit', { outputFile: './.vitest-reports/junit.xml' }]],
    coverage: {
      provider: 'v8',
      include: ['server/**/*.ts', 'contracts/**/*.ts'],
      exclude: ['server/**/*.test.ts', 'contracts/**/*.test.ts'],
    },
  },
});
