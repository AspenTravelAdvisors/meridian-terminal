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
  it('reruns a Signal Tester test read-only and reproducibly', async () => {
    const strategy = { exitOnOpposite: true, stop: 'level', stopPct: 5, atrMult: 2, atrLength: 14, timeStopBars: 20, takeProfitPct: 0, feesBps: 2, slippageBps: 3, entryAt: 'nextOpen', allowShort: false };
    const qs = `symbol=SIM:DEMO&interval=1D&study=td-sequential&signals=SEQ_BUY_SETUP_9,SEQ_SELL_SETUP_9&horizons=1,5,20&bars=800&strategy=${encodeURIComponent(JSON.stringify(strategy))}`;
    const a = await get(`/api/tester?${qs}`);
    expect(a.status).toBe(200);
    const aj = (await a.json()) as { schema: string; replay: string; runs: { hashes: { run: string }; data: { bars: number; toT: number; provider: string }; spec: { studyConfig: Record<string, unknown> }; strategy: { equity: unknown[] } }[] };
    expect(aj.schema).toBe('meridian.test-export/1');
    const run = aj.runs[0];
    expect(run.data.provider).toBe('sim');
    expect(run.strategy.equity).toHaveLength(run.data.bars);
    expect(a.headers.get('x-meridian-run')).toBe(run.hashes.run);
    // the replay link pins the window and reproduces the run exactly
    const b = await get(aj.replay);
    const bj = (await b.json()) as typeof aj;
    expect(bj.runs[0].hashes.run).toBe(run.hashes.run);
    // identical apart from the bar count asked for (the original asked for 800 and dropped the forming bar)
    expect({ ...bj.runs[0], data: { ...bj.runs[0].data, requestedBars: 0 } }).toEqual({ ...run, data: { ...run.data, requestedBars: 0 } });
    const csv = await get(`${aj.replay}&format=csv&part=equity`);
    expect(csv.headers.get('content-type')).toMatch(/text\/csv/);
    expect((await csv.text()).split('\n')[0]).toBe('run_hash,symbol,date,equity,buy_hold,equity_value');
    expect((await get('/api/tester?symbol=SIM:DEMO&study=nope&signals=X')).status).toBe(400);
    expect((await get('/api/tester?symbol=SIM:DEMO&study=td-sequential&signals=X&cfg={bad')).status).toBe(400);
    expect((await post('/api/tester', {})).status).toBe(405);
    // an evaluation window and a walk-forward
    const w = (await (await get(`/api/tester?${qs}&from=2025-01-01&until=2025-12-31`)).json()) as { replay: string; runs: { data: { evaluated: { from: string; to: string } }; strategy: { equity: unknown[] } }[] };
    expect(w.runs[0].data.evaluated).toMatchObject({ from: '2025-01-01', to: '2025-12-31' });
    expect(w.replay).toMatch(/from=2025-01-01&until=2025-12-31/);
    expect((await get(`/api/tester?${qs}&from=2099-01-01`)).status).toBe(422);
    const wf = { trainYears: 1, testYears: 1, metricHorizon: 5, minEvents: 1, param: { key: 'setupLength', values: [8, 9] } };
    const f = (await (await get(`/api/tester?${qs}&wf=${encodeURIComponent(JSON.stringify(wf))}`)).json()) as { schema: string; folds: unknown[]; trials: number };
    expect(f.schema).toBe('meridian.walk-forward/1');
    expect(f.trials).toBe(f.folds.length * 2);
    // combined rules with a weekly condition, replayed exactly
    const rules = { trigger: 'rising', longEntry: { combine: 'all', conditions: [{ kind: 'signal', study: 'td-sequential', signal: 'SEQ_BUY_SETUP_9', withinBars: 0 }, { kind: 'compare', interval: '1W', left: { kind: 'price', field: 'c' }, op: '>', right: { kind: 'line', study: 'sma', cfg: { length: 10 }, output: 'ma' } }] } };
    const ru = (await (await get(`/api/tester?symbol=SIM:DEMO&interval=1D&study=rules&bars=800&horizons=5&rules=${encodeURIComponent(JSON.stringify(rules))}`)).json()) as typeof aj & { runs: { data: { aux?: { interval: string }[] } }[] };
    expect(ru.runs[0].data.aux?.[0].interval).toBe('1W');
    expect(((await (await get(ru.replay)).json()) as typeof aj).runs[0].hashes.run).toBe(ru.runs[0].hashes.run);
    expect((await get('/api/tester?symbol=SIM:DEMO&study=rules')).status).toBe(400);
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

import { assertPublicHttps, isPrivateAddress, notifyRoute } from '../src/routes/notify';
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

describe('notify email recipients', () => {
  const sent: string[] = [];
  const fakeFetch = (async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)).to[0]);
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  const post = (to: string, ip: string) =>
    new Request('https://app.test/api/notify', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      body: JSON.stringify({ channel: 'email', to, subject: 's', text: 't' }),
    });
  const env = { RESEND_API_KEY: 'test-key', ALERT_EMAIL_TO: 'Me@Example.com, alerts@example.org' };

  it('sends only to addresses in ALERT_EMAIL_TO (case-insensitive)', async () => {
    const r = await notifyRoute(post('me@example.com', '203.0.113.1'), env, fakeFetch);
    expect(r.status).toBe(200);
    expect(sent).toEqual(['me@example.com']);
  });

  it('refuses any other recipient without calling the mail API', async () => {
    sent.length = 0;
    await expect(notifyRoute(post('stranger@example.net', '203.0.113.2'), env, fakeFetch)).rejects.toMatchObject({ status: 403 });
    expect(sent).toEqual([]);
  });

  it('is off when ALERT_EMAIL_TO is unset, even with a Resend key', async () => {
    await expect(notifyRoute(post('me@example.com', '203.0.113.3'), { RESEND_API_KEY: 'test-key' }, fakeFetch)).rejects.toMatchObject({ status: 501 });
  });
});
