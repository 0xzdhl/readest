import { webdriverio } from '@vitest/browser-webdriverio';
import { defineConfig } from 'vitest/config';
import { loadEnvFile } from './vitest.env.mts';

// Tauri tests use the same shared .env as the desktop app.
const env = { ...loadEnvFile('.env'), VITE_APP_PLATFORM: 'tauri', CWD: process.cwd() };

export default defineConfig({
  define: {
    'process.env': JSON.stringify(env),
  },
  resolve: {
    tsconfigPaths: true,
    conditions: ['development'],
  },
  test: {
    include: ['src/**/*.tauri.test.ts'],
    setupFiles: ['./vitest.tauri.setup.ts'],
    testTimeout: 30000,
    browser: {
      enabled: true,
      provider: webdriverio({
        hostname: '127.0.0.1',
        port: 4445,
        capabilities: {
          browserName: 'chrome',
        } as WebdriverIO.Capabilities,
      }),
      instances: [{ browser: 'chrome' }],
    },
  },
});
