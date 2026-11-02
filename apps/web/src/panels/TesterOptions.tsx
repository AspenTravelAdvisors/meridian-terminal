import type { TestRunRecord } from '@meridian/engine';
import { type OptionsOverlayResult, type OptionsOverlaySpec, optionsOverlay } from '@meridian/portfolio';
import { Field } from '../components/ui';
import { fmtMoney, fmtNum, fmtPct, fmtPrice } from '../lib/format';

// Signal Tester → strategy mode → Instrument: Options (theoretical). Every stock trade becomes an option trade priced
// with Black-Scholes on modelled volatility. Labelled as a simulation everywhere: Meridian has no historical option quotes.

export const DEFAULT_OPTIONS: OptionsOverlaySpec = {
  dte: 45,
  expiryRule: 'monthly',
  strikeBy: 'delta',
  moneynessPct: 0,
  delta: 0.5,
  strikeStep: 1,
  sizing: { mode: 'premium', value: 1000 },
  spreadPct: 5,
  minSpread: 0.05,
  feePerContract: 0.65,
  vol: { mode: 'realized', lookback: 20, multiplier: 1.1, floor: 0.1 },
  earnings: { dates: [], preBumpPts: 10, preDays: 5 },
  rate: 0.04,
  divYield: 0,
  closeAtDte: 0,
};

/** Run the overlay on a single-symbol strategy record and the bars it used. */
export function overlayFor(rec: TestRunRecord, bars: readonly { t: number; c: number }[], spec: OptionsOverlaySpec): OptionsOverlayResult | null {
  if (!rec.strategy) return null;
  const at = new Map(bars.map((b, i) => [b.t, i]));
  const trades = rec.strategy.trades.flatMap((t) => {
    const entryI = at.get(t.entryT);
    const exitI = at.get(t.exitT);
    return entryI === undefined || exitI === undefined ? [] : [{ entryI, exitI, dir: t.side === 'long' ? (1 as const) : (-1 as const), entry: t.entry, exit: t.exit }];
  });
  return optionsOverlay(bars, trades, spec);
}

const num = (v: number, set: (v: number) => void, w = 'w-16', step = 1, label?: string) => (
  <input className={`input ${w}`} type="number" step={step} value={v} aria-label={label} onChange={(e) => Number.isFinite(Number(e.target.value)) && set(Number(e.target.value))} />
);

export function OptionsControls({ o, set }: { o: OptionsOverlaySpec; set(o: OptionsOverlaySpec): void }) {
  const u = (patch: Partial<OptionsOverlaySpec>) => set({ ...o, ...patch });
  return (
    <div className="flex flex-wrap items-end gap-2 border-b border-border p-2" role="group" aria-label="Option contract assumptions">
      <span className="pb-1 text-[11px] font-semibold text-warn">Options (theoretical)</span>
      <Field label="Days to expiry">{num(o.dte, (v) => u({ dte: Math.max(1, v) }), 'w-14', 1, 'Days to expiry')}</Field>
      <Field label="Expiration">
        <select className="input" value={o.expiryRule} onChange={(e) => u({ expiryRule: e.target.value as OptionsOverlaySpec['expiryRule'] })}>
          <option value="monthly">monthly (3rd Friday on/after)</option>
          <option value="exact">exactly that many days</option>
        </select>
      </Field>
      <Field label="Strike by">
        <span className="flex gap-1">
          <select className="input" value={o.strikeBy} onChange={(e) => u({ strikeBy: e.target.value as OptionsOverlaySpec['strikeBy'] })}>
            <option value="delta">delta</option>
            <option value="moneyness">% out of the money</option>
          </select>
          {o.strikeBy === 'delta' ? num(o.delta, (v) => u({ delta: Math.min(0.99, Math.max(0.01, v)) }), 'w-16', 0.05, 'Target delta') : num(o.moneynessPct, (v) => u({ moneynessPct: v }), 'w-16', 1, 'Percent out of the money')}
        </span>
      </Field>
      <Field label="Strike step $">{num(o.strikeStep, (v) => u({ strikeStep: Math.max(0.01, v) }), 'w-14', 0.5, 'Strike step')}</Field>
      <Field label="Size">
        <span className="flex gap-1">
          <select className="input" value={o.sizing.mode} onChange={(e) => u({ sizing: { mode: e.target.value as 'contracts' | 'premium', value: e.target.value === 'contracts' ? 1 : 1000 } })}>
            <option value="premium">premium budget $</option>
            <option value="contracts">contracts</option>
          </select>
          {num(o.sizing.value, (v) => u({ sizing: { ...o.sizing, value: Math.max(0, v) } }), 'w-20', o.sizing.mode === 'premium' ? 100 : 1, 'Size value')}
        </span>
      </Field>
      <Field label="Spread % of mid">{num(o.spreadPct, (v) => u({ spreadPct: Math.max(0, v) }), 'w-14', 0.5, 'Spread percent')}</Field>
      <Field label="Fee / contract">{num(o.feePerContract, (v) => u({ feePerContract: Math.max(0, v) }), 'w-14', 0.05, 'Fee per contract')}</Field>
      <Field label="Implied vol">
        <span className="flex gap-1">
          <select className="input" value={o.vol.mode} onChange={(e) => u({ vol: e.target.value === 'fixed' ? { mode: 'fixed', iv: 0.3 } : { mode: 'realized', lookback: 20, multiplier: 1.1, floor: 0.1 } })}>
            <option value="realized">trailing realized ×</option>
            <option value="fixed">fixed %</option>
          </select>
          {o.vol.mode === 'fixed'
            ? num(Math.round(o.vol.iv * 100), (v) => u({ vol: { mode: 'fixed', iv: Math.max(1, v) / 100 } }), 'w-14', 1, 'Fixed implied volatility percent')
            : num(o.vol.multiplier, (v) => o.vol.mode === 'realized' && u({ vol: { ...o.vol, multiplier: Math.max(0.1, v) } }), 'w-14', 0.05, 'Realized volatility multiplier')}
        </span>
      </Field>
      <Field label="Earnings dates (first session after)">
        <input className="input w-44" placeholder="2026-01-29, 2026-04-30" value={o.earnings.dates.join(', ')} onChange={(e) => u({ earnings: { ...o.earnings, dates: e.target.value.split(',').map((x) => x.trim()).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)) } })} aria-label="Earnings dates" />
      </Field>
      <Field label="+IV pts before">{num(o.earnings.preBumpPts, (v) => u({ earnings: { ...o.earnings, preBumpPts: Math.max(0, v) } }), 'w-14', 1, 'Event premium in volatility points')}</Field>
      <Field label="days before">{num(o.earnings.preDays, (v) => u({ earnings: { ...o.earnings, preDays: Math.max(0, v) } }), 'w-14', 1, 'Days before earnings')}</Field>
      <Field label="Close at DTE (0 = off)">{num(o.closeAtDte, (v) => u({ closeAtDte: Math.max(0, v) }), 'w-14', 1, 'Close at days to expiry')}</Field>
    </div>
  );
}

const pc = (v: number) => (Number.isFinite(v) ? `${(v * 100).toFixed(0)}%` : '—');

export function OptionsResults({ r }: { r: OptionsOverlayResult }) {
  const s = r.stats;
  return (
    <div className="mt-3">
      <div className="section-title px-0">Options overlay · same entries and exits as the strategy above</div>
      <p className="mb-2 rounded border border-warn/40 bg-warn/10 px-2 py-1 text-[11px]">
        <b>{r.label}.</b> Volatility, spreads and earnings premiums are your assumptions. Meridian has no historical option quotes, so this cannot show what these contracts actually traded at. The options win rate below is its own number, not the stock signal’s.
      </p>
      <div className="mb-2 grid grid-cols-3 gap-2 text-[12px] sm:grid-cols-5 lg:grid-cols-10">
        {[
          ['Option trades', String(s.trades)],
          ['Option win rate', pc(s.winRate)],
          ['Stock win rate', pc(s.stockWinRate)],
          ['Total P/L', fmtMoney(s.totalPnl, 0)],
          ['Premium spent', fmtMoney(s.premiumSpent, 0)],
          ['Return on premium', fmtPct(s.returnOnPremium)],
          ['Avg win', fmtMoney(s.avgWinUsd, 0)],
          ['Avg loss', fmtMoney(s.avgLossUsd, 0)],
          ['Expired worthless', String(s.expiredWorthless)],
          ['Skipped', String(r.skipped)],
        ].map(([k, v]) => (
          <div key={k}><div className="text-[10px] uppercase text-faint">{k}</div><div className="font-semibold tabular-nums">{v}</div></div>
        ))}
      </div>
      <details>
        <summary className="cursor-pointer text-dim">Option trades ({r.trades.length})</summary>
        <table className="table">
          <thead>
            <tr><th>Entry</th><th>Exit</th><th>Contract</th><th className="text-right">Qty</th><th className="text-right">Δ</th><th className="text-right">IV in → out</th><th className="text-right">Ask → bid</th><th className="text-right">Stock</th><th className="text-right">Option</th><th className="text-right">P/L $</th><th>Exit</th></tr>
          </thead>
          <tbody>
            {r.trades.slice(-200).reverse().map((t, k) => (
              <tr key={k}>
                <td>{t.entryDate}</td>
                <td>{t.exitDate}</td>
                <td className="whitespace-nowrap">{t.expiry} {fmtPrice(t.strike)} {t.type}{t.earningsInTrade ? ' · earnings' : ''}</td>
                <td className="text-right">{t.contracts}</td>
                <td className="text-right">{fmtNum(t.entryDelta)}</td>
                <td className="text-right">{(t.entryIv * 100).toFixed(0)}% → {(t.exitIv * 100).toFixed(0)}%</td>
                <td className="text-right">{t.entryAsk.toFixed(2)} → {t.exitBid.toFixed(2)}</td>
                <td className="text-right">{fmtPct(t.stockReturnPct)}</td>
                <td className="text-right" style={{ color: t.pnl >= 0 ? 'var(--ok)' : 'var(--danger)' }}>{fmtPct(t.returnPct)}</td>
                <td className="text-right" style={{ color: t.pnl >= 0 ? 'var(--ok)' : 'var(--danger)' }}>{fmtMoney(t.pnl, 0)}</td>
                <td>{t.exitReason === 'dte' ? 'DTE limit' : t.exitReason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
