import { BellRing, Check, Cloud, Copy, KeyRound, LogOut, RefreshCw, Smartphone, Trash2 } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { Field } from '../components/ui';
import {
  type PushDevice,
  addPasskey,
  currentPushSubscription,
  deleteAccount,
  disablePush,
  editPasskey,
  enablePush,
  newRecoveryCode,
  passkeysSupported,
  pushDevices,
  pushSupport,
  recover,
  signIn,
  signOut,
  signUp,
  testPush,
} from '../lib/account';
import { forgetSyncLink, syncNow, useAccount } from '../state/account';
import { useUi } from '../state/store';
import { SERVER_FRESH_MS } from './Alerts';

const ago = (t?: number | null) => {
  if (!t) return 'never';
  const s = Math.round((Date.now() - t) / 1000);
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86_400 ? `${Math.round(s / 3600)} h ago` : new Date(t).toLocaleDateString();
};
const toastError = (title: string, e: unknown) => useUi.getState().toast({ title, body: e instanceof Error ? e.message : String(e), tone: 'error' });

function Section({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2 border-b border-border p-3">
      <h3 className="flex items-center gap-1.5 text-[12px] font-semibold">
        <span className="text-accent">{icon}</span>
        {title}
      </h3>
      {children}
    </section>
  );
}

function RecoveryCard({ code, onDone }: { code: string; onDone(): void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="rounded-md border border-warn/60 bg-warn/10 p-3" role="alert">
      <p className="text-[12px] font-semibold">Save your recovery code</p>
      <p className="mt-1 text-[11px] text-dim">It signs you in if you ever lose every device with your passkey. It is shown once and works once.</p>
      <code className="mt-2 block select-all rounded bg-panel-2 px-2 py-1.5 text-center font-mono text-[14px] tracking-wider">{code}</code>
      <div className="mt-2 flex gap-2">
        <button className="btn" onClick={() => navigator.clipboard.writeText(code).then(() => setCopied(true))}>
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />} {copied ? 'Copied' : 'Copy'}
        </button>
        <button className="btn btn-primary" onClick={onDone}>I saved it</button>
      </div>
    </div>
  );
}

function SignedOut() {
  const info = useAccount((s) => s.info);
  const refresh = useAccount((s) => s.refresh);
  const [username, setUsername] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [showRecover, setShowRecover] = useState(false);
  const [recUser, setRecUser] = useState('');
  const [recCode, setRecCode] = useState('');
  const supported = passkeysSupported();
  const signup = info?.signup;
  const go = (f: () => Promise<unknown>, what: string) => async () => {
    setBusy(true);
    try {
      await f();
      await refresh();
    } catch (e) {
      toastError(what, e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Section title="Sign in" icon={<KeyRound className="size-4" />}>
        <p className="text-[11px] text-dim">
          Meridian uses passkeys: Face ID, Touch ID, Windows Hello or a security key instead of a password. On Apple devices the passkey syncs through iCloud
          Keychain, so an account made on your iPhone also signs you in on your Mac.
        </p>
        {!supported && <p className="text-[11px] text-warn">This browser does not support passkeys.</p>}
        <button className="btn btn-primary self-start" disabled={busy || !supported} onClick={go(signIn, 'Sign-in failed')}>
          <KeyRound className="size-3.5" /> Sign in with a passkey
        </button>
      </Section>
      {signup?.open && (
        <Section title="Create your account" icon={<Cloud className="size-4" />}>
          <p className="text-[11px] text-dim">This device’s watchlists, alerts, portfolio, journal, drawings, layouts and scripts are copied into the account.</p>
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void go(async () => useAccount.getState().set({ recoveryCode: (await signUp(username, code)).recoveryCode }), 'Sign-up failed')();
            }}
          >
            <Field label="Username" hint="3–32 letters, digits, dots, dashes or underscores.">
              <input className="input" autoComplete="username webauthn" value={username} onChange={(e) => setUsername(e.target.value)} required minLength={3} maxLength={32} />
            </Field>
            {signup.needsCode && (
              <Field label="Invite code">
                <input className="input" value={code} onChange={(e) => setCode(e.target.value)} required />
              </Field>
            )}
            <button className="btn btn-primary self-start" type="submit" disabled={busy || !supported || username.trim().length < 3}>
              Create account with a passkey
            </button>
          </form>
        </Section>
      )}
      {signup && !signup.open && <p className="px-3 pt-2 text-[11px] text-faint">New accounts are closed on this deployment.</p>}
      <div className="p-3">
        <button className="text-[11px] text-accent underline" onClick={() => setShowRecover(!showRecover)}>Lost your devices? Use your recovery code</button>
        {showRecover && (
          <form
            className="mt-2 flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void go(() => recover(recUser, recCode).then(() => useUi.getState().toast({ title: 'Signed in with your recovery code', body: 'Add a passkey for this device and make a new recovery code under Account.', tone: 'ok' })), 'Recovery failed')();
            }}
          >
            <Field label="Username"><input className="input" value={recUser} onChange={(e) => setRecUser(e.target.value)} required /></Field>
            <Field label="Recovery code"><input className="input font-mono" value={recCode} onChange={(e) => setRecCode(e.target.value)} placeholder="XXXXX-XXXXX-XXXXX-XXXXX" required /></Field>
            <button className="btn self-start" type="submit" disabled={busy}>Sign in</button>
          </form>
        )}
      </div>
    </>
  );
}

function PushSection() {
  const [devices, setDevices] = useState<PushDevice[] | null>(null);
  const [mine, setMine] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const support = pushSupport();
  useEffect(() => {
    pushDevices().then(setDevices).catch(() => setDevices([]));
    currentPushSubscription().then((s) => setMine(s?.endpoint ?? null));
  }, []);
  const here = !!mine && !!devices?.some((d) => d.endpoint === mine);
  const act = (f: () => Promise<PushDevice[]>) => async () => {
    setBusy(true);
    try {
      setDevices(await f());
      setMine((await currentPushSubscription())?.endpoint ?? null);
    } catch (e) {
      toastError('Notifications', e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title="Notifications on your devices" icon={<BellRing className="size-4" />}>
      <p className="text-[11px] text-dim">Alerts set to “Notify my devices” are pushed to every device turned on here, even when Meridian is closed.</p>
      {support === 'ios-install' && (
        <p className="rounded bg-panel-2 p-2 text-[11px]">
          On iPhone and iPad, push needs Meridian on your Home Screen: tap <b>Share</b> → <b>Add to Home Screen</b>, open Meridian from the new icon, then come back here.
        </p>
      )}
      {support === 'denied' && <p className="text-[11px] text-warn">Notifications are blocked for this site in the browser settings.</p>}
      {support === 'unsupported' && <p className="text-[11px] text-warn">This browser cannot receive push notifications.</p>}
      <div className="flex flex-wrap gap-2">
        {support === 'ok' && !here && (
          <button className="btn btn-primary" disabled={busy} onClick={act(enablePush)}>
            <Smartphone className="size-3.5" /> Turn on for this device
          </button>
        )}
        {here && <button className="btn" disabled={busy} onClick={act(() => disablePush())}>Turn off for this device</button>}
        {!!devices?.length && (
          <button
            className="btn"
            disabled={busy}
            onClick={() =>
              testPush()
                .then((r) => useUi.getState().toast({ title: r.sent ? `Test sent to ${r.sent} device${r.sent > 1 ? 's' : ''}` : 'No device accepted the test', tone: r.sent ? 'ok' : 'warn' }))
                .catch((e) => toastError('Test notification', e))
            }
          >
            Send a test
          </button>
        )}
      </div>
      {!!devices?.length && (
        <ul className="text-[11px]">
          {devices.map((d) => (
            <li key={d.endpoint} className="flex items-center gap-2 border-t border-border/50 py-1">
              <span className="flex-1 truncate">{d.label ?? 'Device'}{d.endpoint === mine ? ' (this device)' : ''}</span>
              <span className="text-faint">{d.lastOkAt ? `last delivered ${ago(d.lastOkAt)}` : `added ${ago(d.createdAt)}`}</span>
              <button className="icon-btn" aria-label={`Remove ${d.label ?? 'device'}`} onClick={act(() => disablePush(d.endpoint))}><Trash2 className="size-3.5" /></button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function BackgroundAlerts() {
  const scheduler = useAccount((s) => s.scheduler);
  const live = !!scheduler && Date.now() - scheduler.lastRunAt < SERVER_FRESH_MS;
  const url = `${location.origin}/api/cron/alerts`;
  return (
    <Section title="Background alerts" icon={<Cloud className="size-4" />}>
      <p className="text-[11px]">
        Server checks: {scheduler ? <>last run {ago(scheduler.lastRunAt)} · {scheduler.evaluated} checked · {scheduler.fired} fired{scheduler.errors ? ` · ${scheduler.errors} errors` : ''}</> : 'not run yet'}{' '}
        {live ? <span className="text-ok">● running</span> : <span className="text-warn">● not every minute</span>}
      </p>
      {!live && (
        <div className="text-[11px] text-dim">
          <p>To check alerts every minute with Meridian closed, something has to call the scheduler once a minute:</p>
          <ul className="ml-4 mt-1 list-disc">
            <li>Vercel Pro: set <code>ALERT_CRON_SCHEDULE</code> to <code>* * * * *</code> and redeploy (Hobby allows one run a day).</li>
            <li>Any free scheduler, such as cron-job.org, calling this address every minute (add the <code>CRON_SECRET</code> header or <code>?key=</code> if you set one):</li>
          </ul>
          <code className="mt-1 block select-all break-all rounded bg-panel-2 px-2 py-1">{url}</code>
        </div>
      )}
    </Section>
  );
}

function SignedIn() {
  const { info, sync, lastSyncAt, syncError, refresh, set, recoveryCode: recovery } = useAccount();
  const setRecovery = (code: string | null) => set({ recoveryCode: code ?? undefined });
  const user = info!.user!;
  const [busy, setBusy] = useState(false);
  const [passkeys, setPasskeys] = useState(info?.passkeys ?? []);
  useEffect(() => setPasskeys(info?.passkeys ?? []), [info?.passkeys]);
  const run = (f: () => Promise<unknown>, what: string) => async () => {
    setBusy(true);
    try {
      await f();
    } catch (e) {
      toastError(what, e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {recovery && (
        <div className="border-b border-border p-3">
          <RecoveryCard code={recovery} onDone={() => setRecovery(null)} />
        </div>
      )}
      <Section title={`Signed in as ${user.username}`} icon={<Cloud className="size-4" />}>
        <p className="flex items-center gap-2 text-[11px]">
          <span className={sync === 'error' ? 'text-danger' : sync === 'offline' ? 'text-warn' : 'text-ok'}>●</span>
          {sync === 'syncing' ? 'Syncing…' : sync === 'offline' ? 'Offline — changes sync when you reconnect' : sync === 'error' ? `Sync problem: ${syncError}` : `Synced ${ago(lastSyncAt)}`}
          <button className="icon-btn ml-auto" aria-label="Sync now" onClick={() => void syncNow()}><RefreshCw className="size-3.5" /></button>
        </p>
        <p className="text-[11px] text-dim">Watchlists, alerts, portfolio, journal notes, drawings, layouts, scripts and settings follow you to every device you sign in on. Journal screenshots stay on the device that took them.</p>
      </Section>
      <BackgroundAlerts />
      <PushSection />
      <Section title="Passkeys" icon={<KeyRound className="size-4" />}>
        <ul className="text-[11px]">
          {passkeys.map((p) => (
            <li key={p.id} className="flex items-center gap-2 border-b border-border/50 py-1">
              <span className="flex-1 truncate">{p.label ?? 'Passkey'}</span>
              <span className="text-faint">{p.backedUp ? 'synced' : 'this device only'} · used {ago(p.lastUsedAt)}</span>
              <button className="icon-btn" aria-label={`Rename ${p.label ?? 'passkey'}`} onClick={() => { const n = prompt('Passkey name', p.label ?? ''); if (n) void run(async () => setPasskeys((await editPasskey(p.id, { label: n })).passkeys), 'Rename')(); }}>✎</button>
              <button className="icon-btn" aria-label={`Remove ${p.label ?? 'passkey'}`} onClick={() => confirm('Remove this passkey? That device will no longer sign in.') && void run(async () => setPasskeys((await editPasskey(p.id, { remove: true })).passkeys), 'Remove passkey')()}><Trash2 className="size-3.5" /></button>
            </li>
          ))}
        </ul>
        <p className="text-[11px] text-dim">Devices outside iCloud (a Windows PC, an Android phone) can sign in by scanning a QR code with your phone, or get their own passkey here once signed in.</p>
        <button className="btn self-start" disabled={busy} onClick={run(async () => setPasskeys((await addPasskey()).passkeys), 'Add passkey')}>
          <KeyRound className="size-3.5" /> Add a passkey on this device
        </button>
      </Section>
      <Section title="Recovery & sign-out" icon={<LogOut className="size-4" />}>
        {!recovery && (
          <button className="btn self-start" disabled={busy} onClick={run(async () => setRecovery((await newRecoveryCode()).recoveryCode), 'Recovery code')}>Make a new recovery code</button>
        )}
        <div className="flex flex-wrap gap-2">
          <button
            className="btn"
            disabled={busy}
            onClick={run(async () => {
              await signOut();
              forgetSyncLink();
              set({ scheduler: null });
              await refresh();
            }, 'Sign out')}
          >
            <LogOut className="size-3.5" /> Sign out
          </button>
          <button
            className="btn text-danger"
            disabled={busy}
            onClick={() => {
              const c = prompt(`Delete the account and all its cloud data? This device keeps its local copy.\n\nType ${user.username} to confirm.`);
              if (c) void run(async () => {
                await deleteAccount(c);
                forgetSyncLink();
                await refresh();
              }, 'Delete account')();
            }}
          >
            Delete account…
          </button>
        </div>
      </Section>
    </>
  );
}

export function AccountPanel() {
  const status = useAccount((s) => s.status);
  const info = useAccount((s) => s.info);
  const refresh = useAccount((s) => s.refresh);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return (
    <div className="panel-body overflow-auto">
      {status === 'unknown' && <p className="p-3 text-dim">Checking your account…</p>}
      {status === 'unavailable' && (
        <Section title="Accounts are not set up here" icon={<Cloud className="size-4" />}>
          <p className="text-[11px] text-dim">
            {info?.database === 'unreachable'
              ? 'The database is configured but could not be reached. Check DATABASE_URL in the deployment settings.'
              : 'This deployment has no database, so everything stays in this browser. In Vercel: Storage → Create Database → Neon (Postgres), connect it to the project and redeploy. See docs/ACCOUNTS.md.'}
          </p>
        </Section>
      )}
      {status === 'signed-out' && <SignedOut />}
      {status === 'signed-in' && info?.user && <SignedIn />}
    </div>
  );
}
