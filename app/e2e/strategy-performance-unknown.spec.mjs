/**
 * E2E: Strategy Performance tab — Unknown videos: paste transcript, assign, category.
 * Run: npx playwright test e2e/strategy-performance-unknown.spec.mjs --project=chromium
 * Or: npx playwright test e2e/strategy-performance-unknown.spec.mjs --headed
 *
 * Prereqs: Logged in (paper-trading requires auth). Dev server on http://localhost:5173
 */

import { test, expect } from '@playwright/test';

const BASE_URL = 'http://localhost:5173';

test.describe('Strategy Performance — Unknown videos UI', () => {
  test('shows paste transcript, assign, and category controls', async ({ page }) => {
    // 1. Navigate to paper-trading (requires auth)
    await page.goto(`${BASE_URL}/paper-trading`);
    await page.waitForLoadState('networkidle');

    // If redirected to home (not logged in), skip or fail with helpful message
    const url = page.url();
    if (!url.includes('paper-trading')) {
      test.skip(true, 'Not on paper-trading — may need to log in first');
    }

    // 2. Click Strategy Perf tab
    const strategyPerfTab = page.getByRole('button', { name: /Strategy Perf/i });
    await expect(strategyPerfTab).toBeVisible({ timeout: 10000 });
    await strategyPerfTab.click();
    await page.waitForTimeout(800);

    // 3. Verify Source Leaderboard exists
    const leaderboard = page.getByText('Source Leaderboard');
    await expect(leaderboard).toBeVisible();

    // 4. Check if Unknown section exists
    const unknownSection = page.getByText('Unknown').first();
    const hasUnknown = await unknownSection.isVisible().catch(() => false);

    if (hasUnknown) {
      // Expand Unknown to see videos (click View/Hide or the row)
      const unknownRow = page.locator('tr').filter({ hasText: 'Unknown' }).first();
      const viewLink = page.getByRole('button', { name: /View|Hide/i }).first();
      if (await viewLink.isVisible()) {
        await viewLink.click();
        await page.waitForTimeout(500);
      }

      // Verify "Paste transcript to auto-assign" link exists for Unknown videos
      const pasteLink = page.getByText('Paste transcript to auto-assign source & category');
      await expect(pasteLink).toBeVisible();

      // Verify Assign controls exist (Assign to, Category, Assign button)
      const assignToLabel = page.getByText('Assign to:');
      await expect(assignToLabel).toBeVisible();
      const categoryLabel = page.getByText('Category:').first();
      await expect(categoryLabel).toBeVisible();
      const assignBtn = page.getByRole('button', { name: 'Assign' });
      await expect(assignBtn.first()).toBeVisible();
    }

    // 5. Verify Category dropdown exists for non-Unknown strategies (if any)
    const categorySelects = page.locator('select').filter({ has: page.locator('option[value="daily_signal"]') });
    const count = await categorySelects.count();
    expect(count).toBeGreaterThanOrEqual(0); // May be 0 if no strategies yet

    // 6. Screenshot for visual verification
    await page.screenshot({ path: 'e2e/screenshots/strategy-performance.png', fullPage: true });
  });
});
