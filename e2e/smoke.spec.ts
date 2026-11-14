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
  await expect(page.getByRole('link', { name: 'Charts by TradingView Lightweight Charts™' })).toHaveAttribute('href', 'https://www.tradingview.com/');
  await expect(page.locator('footer')).toContainText('© 2025 TradingView, Inc.');
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

test('the walkthrough opens from the command palette', async ({ page }) => {
  await expect(page.locator('[data-testid^="chart-"] canvas').first()).toBeVisible();
  const input = page.getByPlaceholder('Type a command…');
  await expect(async () => {
    if (!(await input.isVisible())) await page.keyboard.press('Control+k');
    await expect(input).toBeFocused({ timeout: 1000 });
  }).toPass({ timeout: 15_000 });
  await input.fill('Open panel: Guide');
  await page.keyboard.press('Enter');
  await expect(page.locator('.guide').getByText('Strategic playbooks').first()).toBeVisible({ timeout: 10_000 });
});

test('Renko box size: auto by default, fixed size from the chart-type menu', async ({ page }) => {
  const errs = errors(page);
  await page.getByRole('button', { name: 'Chart type' }).click();
  await page.getByRole('menuitem', { name: 'Renko' }).click();
  await page.getByRole('button', { name: 'Chart type' }).click();
  await expect(page.getByRole('menuitem', { name: /Box size/ })).toContainText('auto · ATR 14');
  await page.getByRole('menuitem', { name: /Box size/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Renko box size' });
  await expect(dialog.getByText(/Auto size on this chart:/)).toBeVisible();
  await dialog.getByLabel('Box size').fill('2.5');
  await dialog.getByRole('button', { name: 'Apply' }).click();
  await page.getByRole('button', { name: 'Chart type' }).click();
  await expect(page.getByRole('menuitem', { name: /Box size/ })).toContainText('2.500');
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-testid^="chart-"] canvas').first()).toBeVisible();
  expect(errs).toEqual([]);
});

test('Forward Cone: the status panel reads out the outcome range and its track record', async ({ page }) => {
  const errs = errors(page);
  const card = page.getByTestId('cone-card');
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card).toContainText('next 21 bars');
  await expect(card).toContainText(/closed (higher|lower) 21 bars later/);
  await expect(card).toContainText('Four in five');
  await expect(card).toContainText('Track record on this chart');
  await expect(card).toContainText(/On this chart the 80% range held/);
  // the study is on the chart (legend row) as part of the default stack
  await expect(page.locator('[data-testid^="chart-"]').first().locator('..')).toContainText('Cone');
  expect(errs).toEqual([]);
});

test('ratio chart: a typed expression charts one symbol divided by another, with studies', async ({ page }) => {
  const errs = errors(page);
  await page.getByRole('button', { name: 'Symbol search' }).first().click();
  await page.getByLabel('Search symbols').fill('sim:demo / sim:trend');
  await expect(page.getByRole('option', { name: /SIM:DEMO\/SIM:TREND/ })).toBeVisible();
  await page.getByLabel('Search symbols').press('Enter');
  await expect(page.getByText('Expression', { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('SIM:DEMO/SIM:TREND · DeMark-style status', { exact: false })).toBeVisible();
  // the crypto reading of a typed pair is offered first
  await page.getByRole('button', { name: 'Symbol search' }).first().click();
  await page.getByLabel('Search symbols').fill('eth/btc');
  await expect(page.getByRole('option').first()).toContainText('BINANCE:ETHBTC');
  expect(errs).toEqual([]);
});
