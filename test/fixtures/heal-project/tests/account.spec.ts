import { test, expect } from '@playwright/test';

test.describe('Account', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/account.html');
  });

  test('shows my orders', async ({ page }) => {
    await page.locator('#view-orders').click();
    await expect(page.getByText('Order #1001 – Trail backpack')).toBeVisible();
  });

  test('opens the profile editor', async ({ page }) => {
    await page.getByRole('link', { name: 'Edit profile' }).click();
    await expect(page).toHaveURL(/#profile$/);
  });

  test('shows an empty cart', async ({ page }) => {
    await page.locator('#cart-btn').click();
    await expect(page.getByText('Your cart is empty')).toBeVisible();
  });

  test('has the account title', async ({ page }) => {
    await expect(page).toHaveTitle('Acme – My account');
  });
});
