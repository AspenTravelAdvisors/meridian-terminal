import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { ApiError, signInIfRequired } from './api';

/** Client for /api/account, /api/push and /api/alerts (cookie session; same origin only). */
export interface AccountUser {
  id: string;
  username: string;
  createdAt: number;
}
export interface Passkey {
  id: string;
  label: string | null;
  createdAt: number;
  lastUsedAt: number | null;
  backedUp: boolean;
  deviceType: string | null;
}
export interface AccountInfo {
  configured: boolean;
  database?: 'postgres' | 'embedded' | 'none' | 'unreachable';
  user: AccountUser | null;
  signup?: { open: boolean; needsCode: boolean };
  passkeys?: Passkey[];
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, body === undefined ? { credentials: 'same-origin' } : { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch (e) {
    throw new ApiError(0, e instanceof Error ? `network error: ${e.message}` : 'network error');
  }
  signInIfRequired(res);
  const text = await res.text();
  let j: unknown = null;
  try {
    j = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  if (!res.ok || j === null) throw new ApiError(res.status, (j as { error?: string } | null)?.error ?? `HTTP ${res.status}`);
  return j as T;
}
export const apiGet = <T>(path: string) => call<T>(path);
export const apiPost = <T>(path: string, body: unknown = {}) => call<T>(path, body);

export const passkeysSupported = () => typeof window !== 'undefined' && 'PublicKeyCredential' in window;

/** Turn the browser's WebAuthn errors into something a person can act on. */
function friendly(e: unknown): Error {
  const name = (e as { name?: string })?.name;
  if (name === 'NotAllowedError') return new Error('Passkey prompt was cancelled or timed out.');
  if (name === 'InvalidStateError') return new Error('This device already has a passkey for this account.');
  if (name === 'SecurityError') return new Error('Passkeys need HTTPS (or localhost) on the site’s own address.');
  return e instanceof Error ? e : new Error(String(e));
}

export const getAccount = () => apiGet<AccountInfo>('/api/account');

export async function signUp(username: string, code?: string): Promise<{ user: AccountUser; recoveryCode: string }> {
  const { challengeId, options } = await apiPost<{ challengeId: string; options: Parameters<typeof startRegistration>[0]['optionsJSON'] }>('/api/account/register/options', { username, code: code || undefined });
  const response = await startRegistration({ optionsJSON: options }).catch((e) => {
    throw friendly(e);
  });
  return apiPost('/api/account/register/verify', { challengeId, response });
}

export async function signIn(): Promise<{ user: AccountUser }> {
  const { challengeId, options } = await apiPost<{ challengeId: string; options: Parameters<typeof startAuthentication>[0]['optionsJSON'] }>('/api/account/login/options');
  const response = await startAuthentication({ optionsJSON: options }).catch((e) => {
    throw friendly(e);
  });
  return apiPost('/api/account/login/verify', { challengeId, response });
}

export async function addPasskey(): Promise<{ passkeys: Passkey[] }> {
  const { challengeId, options } = await apiPost<{ challengeId: string; options: Parameters<typeof startRegistration>[0]['optionsJSON'] }>('/api/account/passkeys/options');
  const response = await startRegistration({ optionsJSON: options }).catch((e) => {
    throw friendly(e);
  });
  return apiPost('/api/account/passkeys/verify', { challengeId, response });
}

export const editPasskey = (id: string, patch: { label?: string; remove?: boolean }) => apiPost<{ passkeys: Passkey[] }>('/api/account/passkeys/edit', { id, ...patch });
export const recover = (username: string, code: string) => apiPost<{ user: AccountUser }>('/api/account/recover', { username, code });
export const newRecoveryCode = () => apiPost<{ recoveryCode: string }>('/api/account/recovery');
export const signOut = () => apiPost<{ ok: true }>('/api/account/logout');
export const deleteAccount = (confirm: string) => apiPost<{ ok: true }>('/api/account/delete', { confirm });

// ── Web Push ───────────────────────────────────────────────────────────────
export interface PushDevice {
  endpoint: string;
  label: string | null;
  createdAt: number;
  lastOkAt: number | null;
}

export type PushSupport = 'ok' | 'unsupported' | 'ios-install' | 'denied';

/** Can this browser receive push? iPhone/iPad Safari only can once Meridian is added to the Home Screen. */
export function pushSupport(): PushSupport {
  if (typeof window === 'undefined') return 'unsupported';
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  if (ios && !standalone) return 'ios-install';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  return 'ok';
}

function keyBytes(b64: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function deviceLabel(): string {
  const ua = navigator.userAgent;
  const d = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : 'Browser';
  const b = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '';
  return b ? `${d} · ${b}` : d;
}

export async function currentPushSubscription(): Promise<PushSubscription | null> {
  if (!('serviceWorker' in navigator)) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return (await reg?.pushManager.getSubscription()) ?? null;
}

export async function enablePush(): Promise<PushDevice[]> {
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) throw new Error('The offline worker is not installed yet — reload the page and try again.');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Notifications were not allowed for this site.');
  const { publicKey } = await apiGet<{ publicKey: string }>('/api/push/key');
  let sub = await reg.pushManager.getSubscription();
  // a subscription made with another server key cannot be reused
  if (sub && sub.options.applicationServerKey && btoa(String.fromCharCode(...new Uint8Array(sub.options.applicationServerKey))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') !== publicKey) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  return (await apiPost<{ devices: PushDevice[] }>('/api/push/subscribe', { subscription: sub.toJSON(), label: deviceLabel() })).devices;
}

export async function disablePush(endpoint?: string): Promise<PushDevice[]> {
  const sub = await currentPushSubscription();
  const target = endpoint ?? sub?.endpoint;
  if (sub && sub.endpoint === target) await sub.unsubscribe();
  if (!target) return pushDevices();
  return (await apiPost<{ devices: PushDevice[] }>('/api/push/unsubscribe', { endpoint: target })).devices;
}

export const pushDevices = async () => (await apiGet<{ devices: PushDevice[] }>('/api/push/devices')).devices;
export const testPush = () => apiPost<{ sent: number; failed: number }>('/api/push/test');

// ── Server-side alert activity ─────────────────────────────────────────────
export interface ServerAlertEvent {
  id: string;
  alertId: string;
  name: string;
  symbol: string;
  interval: string;
  at: number;
  barT: number;
  message: string;
  provisional: boolean;
  delivered: string[];
}
export interface ServerAlertState {
  alertId: string;
  lastFiredBar: number | null;
  lastFiredAt: number | null;
  lastCheckedAt: number | null;
  lastError: string | null;
  done: boolean;
}
export interface AlertActivity {
  events: ServerAlertEvent[];
  states: ServerAlertState[];
  scheduler: { lastRunAt: number; evaluated: number; fired: number; errors: number } | null;
  serverTime: number;
}
export const alertActivity = (since: number) => apiGet<AlertActivity>(`/api/alerts/activity?since=${since}`);
