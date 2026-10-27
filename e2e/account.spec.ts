import { expect, test } from '@playwright/test';

/**
 * Real WebAuthn ceremony against the production build: Chromium's virtual authenticator stands in for Face ID /
 * Touch ID. The server runs with an in-memory embedded Postgres (MERIDIAN_DATA_DIR=memory://).
 */
test('passkey sign-up, cloud sync to a second device, sign-out and sign-in', async ({ page, context, browser }) => {
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('/?symbol=SIM:DEMO&interval=1D');
  await page.getByRole('button', { name: 'Toggle theme' }).click(); // a local change that must reach the account
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByLabel('Username').fill('brian');
  await page.getByRole('button', { name: 'Create account with a passkey' }).click();

  const code = page.locator('code').filter({ hasText: /^[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}$/ });
  await expect(code).toBeVisible({ timeout: 15_000 });
  const recoveryCode = (await code.textContent())!;
  await page.getByRole('button', { name: 'I saved it' }).click();
  await expect(page.getByText('Signed in as brian')).toBeVisible();

  // this device's stores were copied into the account (stores never changed from their defaults have nothing to copy)
  type Docs = { docs: { key: string; data: { state: { theme?: string } } }[] };
  await expect
    .poll(async () => page.evaluate(async () => ((await (await fetch('/api/sync')).json()) as Docs).docs.map((d) => d.key).sort()), { timeout: 15_000 })
    .toEqual(expect.arrayContaining(['meridian.settings', 'meridian.workspace']));
  const theme = await page.evaluate(async () => ((await (await fetch('/api/sync')).json()) as Docs).docs.find((d) => d.key === 'meridian.settings')?.data.state.theme);
  expect(theme).toBe('light');

  // a second device (fresh browser profile) signs in with the recovery code and receives the first device's settings
  const other = await browser.newContext();
  const phone = await other.newPage();
  await phone.goto('/?symbol=SIM:DEMO&interval=1D');
  await expect(phone.locator('html')).toHaveAttribute('data-theme', 'dark');
  await phone.getByRole('button', { name: 'Sign in', exact: true }).click();
  await phone.getByRole('button', { name: 'Lost your devices? Use your recovery code' }).click();
  await phone.getByLabel('Username').fill('brian');
  await phone.getByLabel('Recovery code').fill(recoveryCode);
  await phone.getByLabel('Recovery code').press('Enter');
  await expect(phone.getByText('Signed in as brian')).toBeVisible({ timeout: 15_000 });
  await expect(phone.locator('html')).toHaveAttribute('data-theme', 'light', { timeout: 15_000 });
  await other.close();

  // a second account cannot be created without an invite code
  const closed = await page.evaluate(async () => (await fetch('/api/account/register/options', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'intruder' }) })).status);
  expect(closed).toBe(403);

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('button', { name: 'Sign in with a passkey' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await expect(page.getByText('Signed in as brian')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'Account: brian' })).toBeVisible();
  expect(errors).toEqual([]);
});
