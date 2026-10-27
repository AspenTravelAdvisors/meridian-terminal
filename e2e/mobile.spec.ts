import { type Page, expect, test } from '@playwright/test';

const nav = (page: Page, name: string) => page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name });

test.beforeEach(async ({ page }) => {
  await page.goto('/?symbol=SIM:DEMO&interval=1D');
  await expect(page.getByTitle('Deterministic simulated data — not market prices').first()).toBeVisible({ timeout: 20_000 });
});

test('phone shell: chart, tab bar and no desktop dock download', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const assets: string[] = [];
  page.on('request', (r) => assets.push(r.url()));
  await page.reload();
  await expect(page.locator('[data-testid^="chart-"] canvas').first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('html')).toHaveAttribute('data-shell', 'mobile');
  for (const t of ['Chart', 'Watchlist', 'DeMark', 'Alerts', 'More']) await expect(nav(page, t)).toBeVisible();
  expect(assets.some((u) => /DesktopShell-/.test(u))).toBe(false);
  expect(errors).toEqual([]);
});

test('touch targets are at least 36 px', async ({ page }) => {
  const small = await page.evaluate(() =>
    [...document.querySelectorAll('header button, nav button')]
      .map((b) => ({ name: b.getAttribute('aria-label') ?? b.textContent?.trim(), r: b.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 0 && (r.width < 36 || r.height < 36))
      .map(({ name, r }) => `${name} ${Math.round(r.width)}×${Math.round(r.height)}`),
  );
  expect(small).toEqual([]);
});

test('picking a symbol from the watchlist returns to the chart', async ({ page }) => {
  await page.getByRole('button', { name: 'Symbol search' }).click();
  await page.getByPlaceholder(/Symbol, name/).fill('SIM:TREND');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Symbol search' })).toContainText('SIM:TREND');
  await nav(page, 'Watchlist').click();
  await page.getByRole('button', { name: 'Open SIM:DEMO' }).click();
  await expect(nav(page, 'Chart')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('button', { name: 'Symbol search' })).toContainText('SIM:DEMO');
});

test('More opens panels full screen with a back button', async ({ page }) => {
  await nav(page, 'More').click();
  await page.getByRole('button', { name: /^Signal Tester/ }).click();
  await page.getByRole('button', { name: 'Run test' }).click();
  await expect(page.getByRole('cell', { name: '20 bars' })).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Back' }).click();
  await page.getByRole('button', { name: /^Guide/ }).click();
  await expect(page.getByPlaceholder('Search the guide')).toBeVisible();
});

test('dialogs become full-screen sheets', async ({ page }) => {
  await page.getByRole('button', { name: 'Studies' }).click();
  const dlg = page.getByRole('dialog');
  await expect(dlg).toBeVisible();
  const box = (await dlg.boundingBox())!;
  const vp = page.viewportSize()!;
  expect(box.width).toBeGreaterThanOrEqual(vp.width - 1);
  expect(box.height).toBeGreaterThanOrEqual(vp.height - 1);
});
