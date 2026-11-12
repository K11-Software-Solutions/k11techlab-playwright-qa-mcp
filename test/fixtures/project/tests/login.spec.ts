import { test, expect } from '@playwright/test';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// The fixture project runs from its own folder; the demo app lives at the repo root.
const v2 = pathToFileURL(path.resolve(process.cwd(), '../../../demo/v2/login.html')).href;

test.describe('Sign in', () => {
  test('stable locators survive the redesign', async ({ page }) => {
    await page.goto(v2);
    await page.getByRole('textbox', { name: 'Email address' }).fill('alex@example.com');
    await page.getByLabel('Password').fill('correct-horse');
    await page.getByRole('button', { name: 'Log in' }).click();
    await expect(page.getByRole('heading', { name: 'Welcome back, Alex' })).toBeVisible();
  });

  test('fragile CSS locator breaks after the redesign', async ({ page }) => {
    await page.goto(v2);
    await page.locator('#login-btn').click();
  });
});
