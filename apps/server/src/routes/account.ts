import {
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { and, count, eq, lt, ne } from 'drizzle-orm';
import { z } from 'zod';
import { currentUser, endSession, requireDb, requireUser, startSession } from '../auth';
import { type Db, databaseUrl, getDb, newId, schema, sha256 } from '../db';
import { HttpError, type ServerEnv, assertSameOrigin, body, json, rateLimit } from '../http';

/**
 * Accounts use passkeys (WebAuthn): no passwords to store or leak. On Apple devices a passkey lives in iCloud
 * Keychain, so signing up on the iPhone signs you in on the Mac with Face ID / Touch ID. Other devices can use the
 * phone through the browser's "use a phone or tablet" QR flow, or add their own passkey once signed in. A one-time
 * recovery code covers losing every device.
 */
const { challenges, credentials, users } = schema;
const RP_NAME = 'Meridian Terminal';
const CHALLENGE_MS = 5 * 60_000;
const USERNAME = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9._-]{2,31}$/, 'use 3–32 letters, digits, dots, dashes or underscores');

const rp = (req: Request) => {
  const u = new URL(req.url);
  return { rpID: u.hostname, origin: u.origin };
};
const userHandle = (id: string) => new Uint8Array(Buffer.from(id, 'base64url'));
const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64url');
const fromB64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64url'));
const label = (req: Request) => {
  const ua = req.headers.get('user-agent') ?? '';
  const device = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Macintosh/.test(ua) ? 'Mac' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '';
  return browser ? `${device} · ${browser}` : device;
};

/** Recovery codes: 4 groups of 5 from an unambiguous alphabet (~99 bits). */
function recoveryCode(): string {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const b = new Uint8Array(20);
  crypto.getRandomValues(b);
  const s = Array.from(b, (x) => A[x % A.length]).join('');
  return `${s.slice(0, 5)}-${s.slice(5, 10)}-${s.slice(10, 15)}-${s.slice(15, 20)}`;
}
const normCode = (c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, '');

async function saveChallenge(db: Db, kind: 'register' | 'login' | 'add', challenge: string, extra: { userId?: string; username?: string } = {}, now = Date.now()) {
  const id = newId();
  await db.delete(challenges).where(lt(challenges.expiresAt, now));
  await db.insert(challenges).values({ id, challenge, kind, userId: extra.userId ?? null, username: extra.username ?? null, expiresAt: now + CHALLENGE_MS });
  return id;
}

/** One-time: the challenge row is deleted as it is read. */
async function takeChallenge(db: Db, id: string, kind: string, now = Date.now()) {
  const rows = await db.delete(challenges).where(eq(challenges.id, id)).returning();
  const c = rows[0];
  if (!c || c.kind !== kind || c.expiresAt < now) throw new HttpError(400, 'sign-in request expired — try again');
  return c;
}

async function signupPolicy(db: Db, env: ServerEnv): Promise<{ open: boolean; needsCode: boolean }> {
  if (env.SIGNUP_CODE) return { open: true, needsCode: true };
  const [{ n }] = await db.select({ n: count() }).from(users);
  // without an invite code only the first (owner) account can be created
  return { open: n === 0, needsCode: false };
}

async function passkeys(db: Db, userId: string) {
  return db
    .select({ id: credentials.id, label: credentials.label, createdAt: credentials.createdAt, lastUsedAt: credentials.lastUsedAt, backedUp: credentials.backedUp, deviceType: credentials.deviceType })
    .from(credentials)
    .where(eq(credentials.userId, userId))
    .orderBy(credentials.createdAt);
}

/** GET /api/account — who am I, and what can this deployment do. */
async function me(req: Request, env: ServerEnv): Promise<Response> {
  const db = await getDb(env).catch(() => null);
  if (!db) return json({ configured: false, database: databaseUrl(env) ? 'unreachable' : 'none', user: null });
  const user = await currentUser(db, req);
  const policy = await signupPolicy(db, env);
  return json({ configured: true, database: databaseUrl(env) ? 'postgres' : 'embedded', user, signup: policy, passkeys: user ? await passkeys(db, user.id) : undefined });
}

async function registerOptions(req: Request, env: ServerEnv): Promise<Response> {
  rateLimit(req, 'auth', 20);
  assertSameOrigin(req);
  const db = await requireDb(env);
  const b = await body(req, z.object({ username: USERNAME, code: z.string().max(200).optional() }));
  const policy = await signupPolicy(db, env);
  if (!policy.open) throw new HttpError(403, 'sign-up is closed on this deployment (set SIGNUP_CODE to invite more accounts)');
  if (policy.needsCode && normCode(b.code ?? '') !== normCode(env.SIGNUP_CODE ?? '')) throw new HttpError(403, 'invite code is not valid');
  const taken = await db.select({ id: users.id }).from(users).where(eq(users.username, b.username)).limit(1);
  if (taken.length) throw new HttpError(409, 'that username is taken');
  const { rpID } = rp(req);
  const userId = newId();
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID,
    userName: b.username,
    userID: userHandle(userId),
    attestationType: 'none',
    authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
  });
  const challengeId = await saveChallenge(db, 'register', options.challenge, { userId, username: b.username });
  return json({ challengeId, options });
}

const verifyBody = z.object({ challengeId: z.string().max(100), response: z.record(z.string(), z.unknown()) });

async function registerVerify(req: Request, env: ServerEnv): Promise<Response> {
  rateLimit(req, 'auth', 20);
  assertSameOrigin(req);
  const db = await requireDb(env);
  const b = await body(req, verifyBody, 50_000);
  const ch = await takeChallenge(db, b.challengeId, 'register');
  const { rpID, origin } = rp(req);
  const v = await verifyRegistrationResponse({ response: b.response as unknown as RegistrationResponseJSON, expectedChallenge: ch.challenge, expectedOrigin: origin, expectedRPID: rpID }).catch((e: Error) => {
    throw new HttpError(400, `passkey could not be verified: ${e.message}`);
  });
  if (!v.verified) throw new HttpError(400, 'passkey could not be verified');
  const policy = await signupPolicy(db, env);
  if (!policy.open) throw new HttpError(403, 'sign-up is closed on this deployment');
  const now = Date.now();
  const code = recoveryCode();
  const userId = ch.userId!;
  try {
    await db.insert(users).values({ id: userId, username: ch.username!, createdAt: now, recoveryHash: await sha256(normCode(code)) });
  } catch {
    throw new HttpError(409, 'that username is taken');
  }
  const c = v.registrationInfo.credential;
  await db.insert(credentials).values({ id: c.id, userId, publicKey: b64(c.publicKey), counter: c.counter, transports: c.transports ?? null, deviceType: v.registrationInfo.credentialDeviceType, backedUp: v.registrationInfo.credentialBackedUp, label: label(req), createdAt: now, lastUsedAt: now });
  const cookie = await startSession(db, req, userId, now);
  return json({ user: { id: userId, username: ch.username, createdAt: now }, recoveryCode: code }, { headers: { 'Set-Cookie': cookie } });
}

async function loginOptions(req: Request, env: ServerEnv): Promise<Response> {
  rateLimit(req, 'auth', 30);
  assertSameOrigin(req);
  const db = await requireDb(env);
  const { rpID } = rp(req);
  // discoverable credentials: the browser offers the passkeys it has for this site, no username needed
  const options = await generateAuthenticationOptions({ rpID, userVerification: 'preferred' });
  return json({ challengeId: await saveChallenge(db, 'login', options.challenge), options });
}

async function loginVerify(req: Request, env: ServerEnv): Promise<Response> {
  rateLimit(req, 'auth', 30);
  assertSameOrigin(req);
  const db = await requireDb(env);
  const b = await body(req, verifyBody, 50_000);
  const ch = await takeChallenge(db, b.challengeId, 'login');
  const resp = b.response as unknown as AuthenticationResponseJSON;
  const [cred] = await db.select().from(credentials).where(eq(credentials.id, String(resp.id ?? ''))).limit(1);
  if (!cred) throw new HttpError(400, 'this passkey is not registered here (it may belong to a deleted account)');
  const { rpID, origin } = rp(req);
  const v = await verifyAuthenticationResponse({
    response: resp,
    expectedChallenge: ch.challenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    credential: { id: cred.id, publicKey: fromB64(cred.publicKey), counter: cred.counter, transports: cred.transports ?? undefined },
  }).catch((e: Error) => {
    throw new HttpError(400, `passkey could not be verified: ${e.message}`);
  });
  if (!v.verified) throw new HttpError(400, 'passkey could not be verified');
  const now = Date.now();
  await db.update(credentials).set({ counter: v.authenticationInfo.newCounter, lastUsedAt: now, backedUp: v.authenticationInfo.credentialBackedUp }).where(eq(credentials.id, cred.id));
  const cookie = await startSession(db, req, cred.userId, now);
  const [u] = await db.select({ id: users.id, username: users.username, createdAt: users.createdAt }).from(users).where(eq(users.id, cred.userId));
  return json({ user: u }, { headers: { 'Set-Cookie': cookie } });
}

/** Add another passkey to the signed-in account (e.g. a Windows PC that cannot use iCloud Keychain). */
async function addOptions(req: Request, env: ServerEnv): Promise<Response> {
  rateLimit(req, 'auth', 20);
  assertSameOrigin(req);
  const db = await requireDb(env);
  const user = await requireUser(db, req);
  const existing = await db.select({ id: credentials.id, transports: credentials.transports }).from(credentials).where(eq(credentials.userId, user.id));
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: rp(req).rpID,
    userName: user.username,
    userID: userHandle(user.id),
    attestationType: 'none',
    excludeCredentials: existing.map((c) => ({ id: c.id, transports: c.transports ?? undefined })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
  });
  return json({ challengeId: await saveChallenge(db, 'add', options.challenge, { userId: user.id }), options });
}

async function addVerify(req: Request, env: ServerEnv): Promise<Response> {
  rateLimit(req, 'auth', 20);
  assertSameOrigin(req);
  const db = await requireDb(env);
  const user = await requireUser(db, req);
  const b = await body(req, verifyBody, 50_000);
  const ch = await takeChallenge(db, b.challengeId, 'add');
  if (ch.userId !== user.id) throw new HttpError(400, 'sign-in request expired — try again');
  const { rpID, origin } = rp(req);
  const v = await verifyRegistrationResponse({ response: b.response as unknown as RegistrationResponseJSON, expectedChallenge: ch.challenge, expectedOrigin: origin, expectedRPID: rpID }).catch((e: Error) => {
    throw new HttpError(400, `passkey could not be verified: ${e.message}`);
  });
  if (!v.verified) throw new HttpError(400, 'passkey could not be verified');
  const c = v.registrationInfo.credential;
  const now = Date.now();
  await db.insert(credentials).values({ id: c.id, userId: user.id, publicKey: b64(c.publicKey), counter: c.counter, transports: c.transports ?? null, deviceType: v.registrationInfo.credentialDeviceType, backedUp: v.registrationInfo.credentialBackedUp, label: label(req), createdAt: now, lastUsedAt: now });
  return json({ passkeys: await passkeys(db, user.id) });
}

async function passkeyEdit(req: Request, env: ServerEnv): Promise<Response> {
  assertSameOrigin(req);
  const db = await requireDb(env);
  const user = await requireUser(db, req);
  const b = await body(req, z.object({ id: z.string().max(1000), remove: z.boolean().optional(), label: z.string().trim().min(1).max(60).optional() }));
  const mine = and(eq(credentials.id, b.id), eq(credentials.userId, user.id));
  if (b.remove) {
    const [{ n }] = await db.select({ n: count() }).from(credentials).where(and(eq(credentials.userId, user.id), ne(credentials.id, b.id)));
    if (n === 0) throw new HttpError(400, 'add another passkey before removing your last one');
    await db.delete(credentials).where(mine);
  } else if (b.label) await db.update(credentials).set({ label: b.label }).where(mine);
  return json({ passkeys: await passkeys(db, user.id) });
}

/** Sign in with the one-time recovery code; the code is consumed, so the client asks for a new passkey next. */
async function recover(req: Request, env: ServerEnv): Promise<Response> {
  rateLimit(req, 'recover', 5);
  assertSameOrigin(req);
  const db = await requireDb(env);
  const b = await body(req, z.object({ username: USERNAME, code: z.string().max(100) }));
  const hash = await sha256(normCode(b.code));
  const [u] = await db.select().from(users).where(eq(users.username, b.username)).limit(1);
  if (!u || !u.recoveryHash || u.recoveryHash !== hash) throw new HttpError(400, 'username or recovery code is not valid');
  await db.update(users).set({ recoveryHash: null }).where(eq(users.id, u.id));
  const cookie = await startSession(db, req, u.id);
  return json({ user: { id: u.id, username: u.username, createdAt: u.createdAt } }, { headers: { 'Set-Cookie': cookie } });
}

async function newRecovery(req: Request, env: ServerEnv): Promise<Response> {
  assertSameOrigin(req);
  const db = await requireDb(env);
  const user = await requireUser(db, req);
  const code = recoveryCode();
  await db.update(users).set({ recoveryHash: await sha256(normCode(code)) }).where(eq(users.id, user.id));
  return json({ recoveryCode: code });
}

async function logout(req: Request, env: ServerEnv): Promise<Response> {
  assertSameOrigin(req);
  const db = await requireDb(env);
  return json({ ok: true }, { headers: { 'Set-Cookie': await endSession(db, req) } });
}

/** Deletes the account and everything it owns (rows cascade). */
async function deleteAccount(req: Request, env: ServerEnv): Promise<Response> {
  assertSameOrigin(req);
  const db = await requireDb(env);
  const user = await requireUser(db, req);
  const b = await body(req, z.object({ confirm: z.string() }));
  if (b.confirm.trim().toLowerCase() !== user.username) throw new HttpError(400, 'type your username to confirm');
  const cookie = await endSession(db, req);
  await db.delete(users).where(eq(users.id, user.id));
  return json({ ok: true }, { headers: { 'Set-Cookie': cookie } });
}

export const accountRoutes = {
  '/api/account': { GET: me },
  '/api/account/register/options': { POST: registerOptions },
  '/api/account/register/verify': { POST: registerVerify },
  '/api/account/login/options': { POST: loginOptions },
  '/api/account/login/verify': { POST: loginVerify },
  '/api/account/passkeys/options': { POST: addOptions },
  '/api/account/passkeys/verify': { POST: addVerify },
  '/api/account/passkeys/edit': { POST: passkeyEdit },
  '/api/account/recover': { POST: recover },
  '/api/account/recovery': { POST: newRecovery },
  '/api/account/logout': { POST: logout },
  '/api/account/delete': { POST: deleteAccount },
};
