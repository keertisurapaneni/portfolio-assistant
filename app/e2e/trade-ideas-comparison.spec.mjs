/**
 * E2E: Compare Trade Ideas (scanner) vs Full Analysis for first 2 tickers.
 * Run: npx playwright test e2e/trade-ideas-comparison.spec.mjs --project=chromium
 * Or: npx playwright test e2e/trade-ideas-comparison.spec.mjs --headed
 *
 * Prereqs: npm run dev running on http://localhost:5173
 */

import { test, expect } from '@playwright/test';

const BASE_URL = 'http://localhost:5173';

function getResultCard(page) {
  return page.locator('div:has(button:has-text("Refresh"))').filter({ hasText: 'Entry' }).first();
}

function getResultSignalLocator(page) {
  return getResultCard(page).getByText(/BUY|SELL|HOLD/).first();
}

function getResultConfidenceLocator(page) {
  return getResultCard(page).locator('text=/\\d+\\s*\\/\\s*10/').first();
}

test.describe('Trade Ideas vs Full Analysis', () => {
  test('compare scanner and full analysis for first 2 tickers', async ({ page }) => {
    const results = [];

    // 1. Navigate to home
    await page.goto(BASE_URL);
    await page.waitForLoadState('networkidle');

    // 2. Click Trade Signals tab
    await page.getByRole('link', { name: /Trade Signals/i }).click();
    await page.waitForURL(/\/signals/);

    // 3. Expand Trade Ideas
    const tradeIdeasHeader = page.getByRole('button', { name: /Trade Ideas/i }).first();
    await tradeIdeasHeader.click();
    await page.waitForTimeout(500);

    // 4. Ensure Day Trades tab is active
    const dayTab = page.getByRole('button', { name: /Day Trades/i });
    if (await dayTab.isVisible()) await dayTab.click();
    await page.waitForTimeout(800);

    // 5. Find idea cards (grid of cards with BUY/SELL + ticker)
    const cards = page.locator('button:has-text("BUY"), button:has-text("SELL")').filter({ hasText: /[A-Z]{2,5}/ });
    const count = await cards.count();
    if (count < 2) {
      console.log('Need at least 2 Trade Idea cards. Found:', count);
      test.skip();
    }

    const getCardData = async (idx) => {
      const card = cards.nth(idx);
      const text = await card.textContent();
      const match = text.match(/(BUY|SELL)\s+([A-Z]{2,5})/);
      const confMatch = text.match(/(\d+)\s*\/\s*10/);
      return {
        signal: match?.[1] ?? '?',
        ticker: match?.[2] ?? '?',
        confidence: confMatch ? parseInt(confMatch[1], 10) : null,
      };
    };

    const idea1 = await getCardData(0);
    const idea2 = await getCardData(1);
    results.push({ ticker: idea1.ticker, scannerSignal: idea1.signal, scannerConf: idea1.confidence });
    results.push({ ticker: idea2.ticker, scannerSignal: idea2.signal, scannerConf: idea2.confidence });

    const getSignalBtn = page.getByRole('button', { name: /Get signal/i });

    // 6. Test first ticker
    await cards.nth(0).click();
    await page.waitForTimeout(400);
    await getSignalBtn.click();
    await page.waitForSelector('button:has-text("Refresh")', { timeout: 25000 }).catch(() => {});
    await page.waitForTimeout(1500);

    let recEl = getResultSignalLocator(page);
    const recText1 = await recEl.textContent().catch(() => null);
    const rec1 = recText1?.match(/BUY|SELL|HOLD/)?.[0] ?? '?';
    const confText1 = await getResultConfidenceLocator(page).textContent().catch(() => null);
    const fullConf1 = confText1 ? parseInt(confText1.replace(/\D/g, '').slice(0, 2), 10) : null;

    results[0].fullSignal = rec1;
    results[0].fullConf = fullConf1;

    // 7. Test second ticker
    await cards.nth(1).click();
    await page.waitForTimeout(400);
    await getSignalBtn.click();
    await page.waitForSelector('button:has-text("Refresh")', { timeout: 25000 }).catch(() => {});
    await page.waitForTimeout(1500);

    recEl = getResultSignalLocator(page);
    const recText2 = await recEl.textContent().catch(() => null);
    const rec2 = recText2?.match(/BUY|SELL|HOLD/)?.[0] ?? '?';
    const confText2 = await getResultConfidenceLocator(page).textContent().catch(() => null);
    const fullConf2 = confText2 ? parseInt(confText2.replace(/\D/g, '').slice(0, 2), 10) : null;

    results[1].fullSignal = rec2;
    results[1].fullConf = fullConf2;

    // 8. Output comparison table
    console.log('\n=== COMPARISON TABLE ===\n');
    console.log('| Ticker | Scanner Signal | Scanner Confidence | Full Analysis Signal | Full Analysis Confidence | Match? |');
    console.log('|--------|----------------|-------------------|---------------------|--------------------------|--------|');
    for (const r of results) {
      const match = r.scannerSignal === r.fullSignal ? 'Yes' : 'No';
      console.log(`| ${r.ticker} | ${r.scannerSignal} | ${r.scannerConf ?? '?'}/10 | ${r.fullSignal} | ${r.fullConf ?? '?'}/10 | ${match} |`);
    }

    expect(results[0].fullSignal).toMatch(/BUY|SELL|HOLD/);
  });
});
