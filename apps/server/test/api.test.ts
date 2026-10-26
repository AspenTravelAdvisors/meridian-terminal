import { describe, expect, it } from 'vitest';
import { handle } from '../src';

const env = {};
const noNet = (async () => new Response('offline', { status: 503 })) as unknown as typeof fetch;
const get = (path: string, headers: Record<string, string> = {}) => handle(new Request(`http://localhost${path}`, { headers }), env, noNet);
const post = (path: string, body: unknown) =>
  handle(new Request(`http://localhost${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }), env, noNet);

describe('API', () => {
  it('health reports the rule-based analyst without a key', async () => {
    const r = await get('/api/health');
    expect(await r.json()).toMatchObject({ ok: true, analyst: 'rule-based' });
  });
  it('serves simulated bars in wire format with CDN caching', async () => {
    const r = await get('/api/bars?symbol=SIM:DEMO&interval=1D&limit=50');
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toMatch(/s-maxage/);
    const j = (await r.json()) as { bars: number[][]; simulated: boolean; symbol: string };
    expect(j.simulated).toBe(true);
    expect(j.symbol).toBe('SIM:DEMO');
    expect(j.bars).toHaveLength(50);
    expect(j.bars[0]).toHaveLength(6);
  });
  it('validates input and reports provider failures honestly', async () => {
    expect((await get('/api/bars?symbol=<script>')).status).toBe(400);
    expect((await get('/api/bars?symbol=AAPL&interval=7m')).status).toBe(400);
    const r = await get('/api/bars?symbol=AAPL');
    expect(r.status).toBe(502);
    expect(((await r.json()) as { error: string }).error).toMatch(/all providers failed/);
  });
  it('runs the screener and MTF matrix server-side', async () => {
    const s = await post('/api/scan', { symbols: ['SIM:DEMO', 'SIM:TREND'], interval: '1D', lookback: 50 });
    const sj = (await s.json()) as { rows: { symbol: string; statuses: Record<string, unknown>; signals: unknown[] }[] };
    expect(sj.rows).toHaveLength(2);
    expect(sj.rows[0].statuses['td-sequential']).toBeTruthy();
    const m = await post('/api/matrix', { symbols: ['SIM:DEMO'], intervals: ['1D', '1W'] });
    const mj = (await m.json()) as { cells: { cell?: { label: string } }[] };
    expect(mj.cells).toHaveLength(2);
    expect(mj.cells[0].cell?.label).toBeTruthy();
    expect((await post('/api/scan', { symbols: ['SIM:DEMO'], studies: [{ id: 'nope' }] })).status).toBe(400);
  });
  it('falls back to a deterministic rule-based briefing', async () => {
    const r = await post('/api/analyst', { symbol: 'SIM:DEMO', interval: '1D', context: { simulated: true, chips: [{ text: 'B-Setup 7', dir: 'bull' }], recentSignals: [{ id: 'SEQ_BUY_SETUP_9', barsAgo: 2, dir: 'bull' }] } });
    expect(r.headers.get('x-meridian-analyst')).toBe('rule-based');
    const t = await r.text();
    expect(t).toMatch(/Simulated data/);
    expect(t).toMatch(/not investment advice/);
  });
  it('404s unknown routes, 405s wrong methods, and only reflects allowed origins', async () => {
    expect((await get('/api/nope')).status).toBe(404);
    expect((await get('/api/scan')).status).toBe(405);
    expect((await get('/api/health', { origin: 'https://evil.example' })).headers.get('access-control-allow-origin')).toBeNull();
    expect((await get('/api/health', { origin: 'http://localhost' })).headers.get('access-control-allow-origin')).toBe('http://localhost');
  });
});

import { assertPublicHttps, isPrivateAddress } from '../src/routes/notify';
describe('notify SSRF guard', () => {
  it('rejects private, non-https and credentialed targets', async () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '::1', '::ffff:10.0.0.1', 'fd00::1']) expect(isPrivateAddress(ip)).toBe(true);
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
    const pub = async () => ['93.184.216.34'];
    await expect(assertPublicHttps('http://example.com/hook', pub)).rejects.toThrow(/https/);
    await expect(assertPublicHttps('https://user:pw@example.com/', pub)).rejects.toThrow(/credentials/);
    await expect(assertPublicHttps('https://169.254.169.254/latest', pub)).rejects.toThrow(/private/);
    await expect(assertPublicHttps('https://rebind.example/', async () => ['10.0.0.5'])).rejects.toThrow(/private/);
    await expect(assertPublicHttps('https://hooks.example.com/x', pub)).resolves.toBeInstanceOf(URL);
  });
});
