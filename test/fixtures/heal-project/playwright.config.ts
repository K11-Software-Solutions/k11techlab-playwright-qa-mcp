import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 10_000,
  expect: { timeout: 2_000 },
  workers: 1,
  use: {
    baseURL: process.env.DEMO_URL,
    storageState: '.qa-mcp/auth/demo.json',
    actionTimeout: 2_000,
  },
});
