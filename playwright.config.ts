import { defineConfig } from '@playwright/test'
import path from 'node:path'

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 120_000,
  expect: {
    timeout: 10_000
  },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'off'
  },
  projects: [
    {
      name: 'electron',
      testMatch: /.*\.e2e\.ts/
    }
  ],
  outputDir: 'tests/e2e/test-results',
  snapshotDir: 'tests/e2e/screenshots',
  snapshotPathTemplate: '{snapshotDir}/{arg}{ext}'
})