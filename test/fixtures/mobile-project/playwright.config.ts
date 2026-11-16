import { defineConfig, devices } from '@playwright/test';

// A desktop project and a mobile project, as in Playwright's own template.
export default defineConfig({
  testDir: './tests',
  timeout: 10_000,
  expect: { timeout: 1_500 },
  workers: 1,
  use: { baseURL: process.env.SHOP_URL, actionTimeout: 1_500 },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], baseURL: process.env.SHOP_URL } },
    { name: 'Mobile Chrome', use: { ...devices['Pixel 5'], baseURL: process.env.SHOP_URL } },
  ],
});
