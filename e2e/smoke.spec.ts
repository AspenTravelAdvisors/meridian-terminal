import { type Page, expect, test } from '@playwright/test';

const errors = (page: Page) => {
  const out: string[] = [];
  page.on('pageerror', (e) => out.push(e.message));
  return out;
};

test.beforeEach(async ({ page }) => {
  await page.goto('/?symbol=SIM:DEMO&interval=1D');
  await expect(page.getByText('SIMULATED').first()).toBeVisible({ timeout: 20_000 });
});

test('chart loads simulated data with DeMark-style studies and the required attribution', async ({ page }) => {
  const errs = errors(page);
  await expect(page.locator('[data-testid^="chart-"] canvas').first()).toBeVisible();
  await expect(page.getByText('Charts by TradingView Lightweight Charts™')).toBeVisible();
  await expect(page.locator('footer')).toContainText('1,500 bars');
  await expect(page.getByText('SIM:DEMO · DeMark-style status', { exact: false })).toBeVisible();
  expect(errs).toEqual([]);
});

test('rule inspector explains the hovered bar', async ({ page }) => {
  await page.locator('.dv-tab', { hasText: 'Rule Inspector' }).click();
  await expect(page.getByText('DeMark-style Sequential').first()).toBeVisible();
  await expect(page.getByText(/setup bar/i).first()).toBeVisible();
});

test('screener scans the simulated universe', async ({ page }) => {
  await page.locator('.dv-tab', { hasText: 'Screener' }).click();
  await page.locator('select').filter({ hasText: 'Simulated' }).first().selectOption('Simulated');
  await page.getByRole('button', { name: 'Scan', exact: true }).click();
  await expect(page.getByText('SIM:TREND')).toBeVisible({ timeout: 20_000 });
});

test('signal tester runs an event study', async ({ page }) => {
  await page.locator('.dv-tab', { hasText: 'Signal Tester' }).click();
  await page.getByRole('button', { name: 'Run test' }).click();
  await expect(page.getByRole('cell', { name: '20 bars' })).toBeVisible({ timeout: 20_000 });
});

test('script editor runs a sandboxed study and adds it to the chart', async ({ page }) => {
  await page.locator('.dv-tab', { hasText: 'Script Editor' }).click();
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByText(/No look-ahead detected/)).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Add to chart' }).click();
  await expect(page.getByText('MA crossover').first()).toBeVisible();
});

test('analyst returns a briefing (rule-based without an API key)', async ({ page }) => {
  await page.locator('.dv-tab', { hasText: 'AI Analyst' }).click();
  await page.getByRole('button', { name: 'Brief me' }).click();
  await expect(page.getByText(/not investment advice/i).last()).toBeVisible({ timeout: 30_000 });
});

test('theme toggles and persists', async ({ page }) => {
  await page.getByRole('button', { name: 'Toggle theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('keyboard: command palette opens and runs a command', async ({ page }) => {
  await expect(page.locator('[data-testid^="chart-"] canvas').first()).toBeVisible();
  const input = page.getByPlaceholder('Type a command…');
  // the global hotkey listener attaches after first render; retry the keystroke until the palette is up
  await expect(async () => {
    if (!(await input.isVisible())) await page.keyboard.press('Control+k');
    await expect(input).toBeFocused({ timeout: 1000 });
  }).toPass({ timeout: 15_000 });
  await input.fill('Interval: 1W');
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-testid^="chart-"]').first().locator('..')).toContainText('1W', { timeout: 15_000 });
});
