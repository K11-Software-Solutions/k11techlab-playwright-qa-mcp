import { test, expect } from '@playwright/test';

test('starts checkout', async ({ page }) => {
  await page.goto('/shop.html');
  await page.getByRole('button', { name: 'Checkout' }).click();
  await expect(page.getByText('Checkout started')).toBeVisible();
});
