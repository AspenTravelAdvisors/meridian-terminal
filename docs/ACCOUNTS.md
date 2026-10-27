# Accounts, sync and background alerts

Without an account Meridian keeps everything in the browser, and alerts only run while a tab is open. With an account:

- **Sync:** watchlists, alerts and the alert log, portfolio, journal notes, drawings, layouts and templates, scripts, study
  defaults, settings and the chart workspace follow you to every device you sign in on. Journal screenshots stay on the
  device that took them.
- **Background alerts:** a server scheduler checks every alert and delivers it with all your Meridian tabs closed. It sends
  Web Push to your phone and computers, plus webhook and e-mail where set.
- **Backup:** clearing a browser's site data no longer loses anything. Sign in again and it comes back.

## How sign-in works (and why not iCloud)

Accounts use **passkeys** instead of passwords. A passkey is a key pair made by your device. The private half never
leaves the device's secure hardware and is unlocked with Face ID, Touch ID, Windows Hello or a security key. The server
stores only the public half, so there is no password to leak or phish.

On Apple devices passkeys are saved in **iCloud Keychain**. If you create the account on your iPhone, your Mac and iPad
already have the passkey, so you get the iCloud-style experience without Meridian depending on iCloud. Building on iCloud
itself (CloudKit) would need an Apple Developer membership and container setup, and it still couldn't run alerts while
your devices are asleep. A server can, so the data lives in Meridian's own Postgres database.

- **Other devices** (a Windows PC, an Android phone) sign in by choosing "use a phone or tablet" in the passkey prompt and
  scanning the QR code with the iPhone. Once signed in, **Account → Add a passkey on this device** gives them their own passkey.
- **Recovery code:** shown once at sign-up. It signs you in one time if you lose every device, and then you add a new
  passkey and make a new code. Keep it in a password manager or on paper.
- **Who can sign up:** without `SIGNUP_CODE` only the **first** account can be created (the owner's), and sign-up then closes.
  Set `SIGNUP_CODE` to invite others; they enter it when signing up.
- Passkeys are bound to the site's address. Use the production domain (`meridian-terminal-lac.vercel.app` or your own
  domain). A passkey made on a preview URL won't work on production.

## One-time setup on Vercel (about 5 minutes)

1. **Add the database.** In the Vercel dashboard open the project → **Storage** → **Create Database** → **Neon**
   (Serverless Postgres, free tier is enough) → connect it to the `meridian-terminal` project for Production (and Preview if
   you want). Vercel adds `DATABASE_URL` to the project's environment variables. Tables are created automatically on first use.
2. **Optional variables** (Project → Settings → Environment Variables):

   | Variable | Why |
   |---|---|
   | `CRON_SECRET` | any long random string. Vercel Cron sends it automatically, and external schedulers must send it too. |
   | `SIGNUP_CODE` | invite code for accounts after the first. |
   | `ALERT_CRON_SCHEDULE` | `* * * * *` on a Pro plan (see below). Default: once a day. |
   | `VAPID_SUBJECT` | `mailto:you@example.com`, the contact push services may use. Keys are generated automatically. |
   | `RESEND_API_KEY`, `ALERT_EMAIL_FROM` | e-mail alerts. |

3. **Redeploy** (Deployments → ⋯ → Redeploy) so the function picks up the variables.
4. Open the site → top bar **person icon** (phone: **More → Account**) → **Create account with a passkey**. Save the
   recovery code.

## Background alerts: making them run every minute

The scheduler endpoint is `/api/cron/alerts`. Each call checks every enabled alert of every account once: it fetches each
market once, fires at most once per bar, and records the firing so the browser and the server never both deliver it. Calls
closer than 45 seconds apart are skipped, so calling it more often costs nothing.

Something has to call it. Vercel Cron does on any plan, but **Hobby allows one run per day** (a more frequent schedule fails
the deployment). That's why the default is daily. Pick one of these for minute-by-minute alerts:

- **Vercel Pro:** set `ALERT_CRON_SCHEDULE` to `* * * * *` and redeploy.
- **Free external scheduler** such as [cron-job.org](https://cron-job.org): create a job for
  `https://<your-domain>/api/cron/alerts` every minute, with the header `Authorization: Bearer <CRON_SECRET>`, or append
  `?key=<CRON_SECRET>` to the URL. Upstash QStash schedules or a GitHub Actions workflow also work. GitHub's cron runs at
  most every 5 minutes and is often late.

**Account → Background alerts** shows the last run. While the server has run in the last 3 minutes, open tabs stop
checking alerts themselves and just show the server's firings. Otherwise they keep checking as before, so alerts never go
unwatched while the app is open.

Each run has a 45-second budget. Script alerts run in a QuickJS WebAssembly sandbox with no network, a memory ceiling and a
deadline, so a user script can't reach the server or other accounts.

## Push notifications on iPhone, iPad, Mac and Android

1. Sign in, then open **Account → Notifications on your devices → Turn on for this device** and allow notifications.
2. **iPhone / iPad (iOS 16.4+):** Safari only delivers web push to apps on the Home Screen. Tap **Share → Add to Home
   Screen**, open Meridian from the new icon, sign in (Face ID), and turn notifications on there.
3. **Send a test** confirms delivery. Tapping a notification opens that alert's chart.
4. In the Alerts panel, **Notify my devices** on an alert sends it as push to every device you turned on.

Each device appears in the list with when it last received a push. Remove a device there, or with **Turn off for this device**.

## Privacy and security

- The database holds your synced documents, passkey public keys, hashed session tokens and a hashed recovery code. It holds
  no passwords and no private keys.
- Sessions are HttpOnly, Secure, SameSite=Lax cookies that last 120 days and are renewed while used. Writes from other sites
  are refused.
- **Account → Delete account** removes the account and everything stored for it. This device keeps its local copy.
- Signing out keeps this device's data. The next sign-in merges it with the account again.

## Running locally or self-hosted

`pnpm dev` and `pnpm serve` need no setup. Without `DATABASE_URL` they use an embedded Postgres (PGlite) in
`.meridian-data/` (`MERIDIAN_DATA_DIR` overrides). Passkeys work on `http://localhost`. For a self-hosted scheduler, have
cron call `curl -fsS -H "Authorization: Bearer $CRON_SECRET" http://localhost:8787/api/cron/alerts` every minute.

## How sync handles two devices

Each store is one document with a revision number. A device sends its change together with the revision it started from.
If another device wrote in between, the server refuses the write and returns its copy, and the device **merges**:

- Collections (watchlists, alerts, alert log, transactions, notes, drawings, layouts, scripts) are combined by id, so
  nothing created on either device is lost.
- Settings and the chart workspace take the newer cloud copy.

A deletion made on one device while the other device was editing the same store can come back after a merge. Delete it
again.
