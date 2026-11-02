import { type ExecutionAssumptions, type MarketAssumptions, type OptionPosition, type ScenarioPlan, bsGreeks, evaluatePlan, impliedVol, ivOn, priceGrid, scenarioDates, yearFrac } from '@meridian/portfolio';
import { RotateCcw } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Field } from '../components/ui';
import { fmtMoney } from '../lib/format';
import { type ScenarioInputs, useScenario } from '../state/store';
import { useActive } from './hooks';

const today = () => new Date().toLocaleDateString('en-CA'); // local YYYY-MM-DD
/** option and stock prices to the cent */
const px = (v: number) => (Number.isFinite(v) ? v.toFixed(2) : '—');
const signed = (v: number) => (Number.isFinite(v) ? `${v >= 0 ? '+' : '−'}${fmtMoney(Math.abs(v), 0)}` : '—');
const pnlColor = (v: number) => (v > 0.5 ? 'var(--ok)' : v < -0.5 ? 'var(--danger)' : undefined);
const shortDay = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** A number input; `optional` inputs map an empty box to null. */
function Num({ value, onChange, step = 1, w = 'w-20', optional, label }: { value: number | null; onChange(v: number | null): void; step?: number; w?: string; optional?: boolean; label: string }) {
  return (
    <input
      className={`input ${w}`}
      type="number"
      step={step}
      aria-label={label}
      value={value ?? ''}
      placeholder={optional ? 'auto' : undefined}
      onChange={(e) => {
        const v = e.target.value === '' ? null : Number(e.target.value);
        if (v === null ? optional : Number.isFinite(v)) onChange(v);
      }}
    />
  );
}

interface PlanDef {
  id: string;
  label: string;
  plan: ScenarioPlan;
}

export function ScenarioPanel() {
  const inp = useScenario((s) => s.inputs);
  const set = useScenario((s) => s.set);
  const reset = useScenario((s) => s.reset);
  const { pane, rt } = useActive();
  const symbol = inp.symbol.trim().toUpperCase() || pane.symbol;
  const chartSpot = symbol === pane.symbol ? rt.bars[rt.bars.length - 1]?.c : undefined;
  const spot = inp.spot ?? chartSpot ?? inp.strike;
  const now = today();

  const model = useMemo(() => {
    const pos: OptionPosition = { contract: { type: inp.type, strike: inp.strike, expiry: inp.expiry }, quantity: inp.quantity, entryPrice: inp.entryPrice, entryFeePerContract: inp.entryFee };
    const market: MarketAssumptions = { rate: inp.rate / 100, divYield: inp.divYield / 100, ivBefore: inp.ivBefore / 100, ivAfter: inp.ivAfter / 100, earningsDate: inp.earningsDate || undefined };
    const exec: ExecutionAssumptions = { halfSpread: inp.halfSpread, feePerContract: inp.exitFee };
    const cost = inp.quantity * (inp.entryPrice * 100 + inp.entryFee);
    const capital = inp.capital ?? cost;
    const T = yearFrac(now, inp.expiry);
    const ivNow = ivOn(market, now);
    const g = bsGreeks(inp.type, spot, inp.strike, T, market.rate, market.divYield, ivNow);
    const markNow = evaluatePlan(pos, { kind: 'hold' }, exec, market, spot, now, capital).mark;
    const closePrice = inp.bid ?? Math.max(0, markNow - inp.halfSpread);
    const bidIv = inp.bid !== null ? impliedVol(inp.bid + inp.halfSpread, inp.type, spot, inp.strike, T, market.rate, market.divYield) : NaN;
    const sellQty = Math.min(inp.quantity, Math.max(1, inp.sellQty));
    const plans: PlanDef[] = [
      { id: 'hold', label: `Hold all ${inp.quantity}`, plan: { kind: 'hold' } },
      { id: 'close', label: `Close all ${inp.quantity} now @ ${px(closePrice)}`, plan: { kind: 'closeNow', price: closePrice } },
      { id: 'limit', label: `Sell ${sellQty} @ ${px(inp.limit)} limit, hold ${inp.quantity - sellQty}`, plan: { kind: 'sellAtLimit', quantity: sellQty, limit: inp.limit } },
    ];
    const breakeven = inp.type === 'call' ? inp.strike + cost / (inp.quantity * 100) : inp.strike - cost / (inp.quantity * 100);
    const dates = scenarioDates(now, inp.expiry, market.earningsDate);
    const prices = priceGrid(spot, inp.rangePct, inp.rows, [inp.strike, breakeven]);
    const at = (plan: ScenarioPlan, S: number, date: string, m = market) => evaluatePlan(pos, plan, exec, m, S, date, capital);
    return { pos, market, cost, capital, T, ivNow, g, markNow, closePrice, bidIv, plans, breakeven, dates, prices, at };
  }, [inp, spot, now]);

  const [planId, setPlanId] = useState('limit');
  const [dateSel, setDateSel] = useState<string | null>(null);
  const [priceSel, setPriceSel] = useState<number | null>(null);
  const date = dateSel && model.dates.includes(dateSel) ? dateSel : (model.dates.find((d) => !!model.market.earningsDate && d >= model.market.earningsDate) ?? model.dates[model.dates.length - 1]);
  const price = priceSel !== null && model.prices.includes(priceSel) ? priceSel : model.prices.reduce((a, b) => (Math.abs(b - spot) < Math.abs(a - spot) ? b : a), model.prices[0]);
  const plan = model.plans.find((p) => p.id === planId) ?? model.plans[0];
  const ivList = inp.ivAfterList.split(',').map((x) => Number(x.trim())).filter((x) => x > 0 && x < 500);
  const expired = model.T <= 0;
  const u = (patch: Partial<ScenarioInputs>) => set(patch);
  const rowLabel = (S: number) => (S === inp.strike ? 'strike' : Math.abs(S - model.breakeven) < 0.005 ? 'breakeven' : Math.abs(S - spot) < 0.005 ? 'now' : '');

  return (
    <div className="panel-body flex flex-col">
      <div className="flex flex-wrap items-end gap-2 border-b border-border p-2">
        <Field label="Symbol"><input className="input w-20" value={inp.symbol} placeholder={pane.symbol} onChange={(e) => u({ symbol: e.target.value })} aria-label="Symbol" /></Field>
        <Field label={`Stock now${inp.spot === null ? (chartSpot !== undefined ? ' (chart)' : ' (enter it)') : ''}`}><Num label="Stock price now" value={inp.spot ?? (chartSpot !== undefined ? Number(chartSpot.toFixed(2)) : null)} onChange={(v) => u({ spot: v })} step={0.5} optional /></Field>
        <Field label="Type">
          <select className="input" value={inp.type} onChange={(e) => u({ type: e.target.value as 'call' | 'put' })}>
            <option value="call">Call</option>
            <option value="put">Put</option>
          </select>
        </Field>
        <Field label="Strike"><Num label="Strike" value={inp.strike} onChange={(v) => u({ strike: v ?? inp.strike })} step={2.5} w="w-20" /></Field>
        <Field label="Expiration"><input className="input" type="date" value={inp.expiry} onChange={(e) => e.target.value && u({ expiry: e.target.value })} aria-label="Expiration" /></Field>
        <Field label="Contracts"><Num label="Contracts" value={inp.quantity} onChange={(v) => u({ quantity: Math.max(1, Math.round(v ?? 1)) })} w="w-16" /></Field>
        <Field label="Paid / share"><Num label="Premium paid per share" value={inp.entryPrice} onChange={(v) => u({ entryPrice: v ?? inp.entryPrice })} step={0.05} w="w-20" /></Field>
        <Field label="Your bid now"><Num label="Current bid per share" value={inp.bid} onChange={(v) => u({ bid: v })} step={0.05} w="w-20" optional /></Field>
        <Field label="Capital before trade"><Num label="Capital before the trade" value={inp.capital} onChange={(v) => u({ capital: v })} step={100} w="w-24" optional /></Field>
        <button className="btn-ghost h-7" onClick={reset} title="Restore the example position"><RotateCcw className="size-3.5" /> Reset</button>
      </div>
      <div className="flex flex-wrap items-end gap-2 border-b border-border p-2">
        <Field label="IV before earnings %"><Num label="Implied volatility before earnings, percent" value={inp.ivBefore} onChange={(v) => u({ ivBefore: v ?? inp.ivBefore })} w="w-16" /></Field>
        <Field label="Earnings (first session after)"><input className="input" type="date" value={inp.earningsDate} onChange={(e) => u({ earningsDate: e.target.value })} aria-label="First session after earnings" /></Field>
        <Field label="IV after earnings %"><Num label="Implied volatility after earnings, percent" value={inp.ivAfter} onChange={(v) => u({ ivAfter: v ?? inp.ivAfter })} w="w-16" /></Field>
        <Field label="Post-earnings IVs to compare"><input className="input w-28" value={inp.ivAfterList} onChange={(e) => u({ ivAfterList: e.target.value })} aria-label="Post-earnings volatilities to compare" /></Field>
        <Field label="Sell"><Num label="Contracts to sell at the limit" value={inp.sellQty} onChange={(v) => u({ sellQty: Math.max(1, Math.round(v ?? 1)) })} w="w-14" /></Field>
        <Field label="at limit"><Num label="Limit price per share" value={inp.limit} onChange={(v) => u({ limit: v ?? inp.limit })} step={0.05} w="w-20" /></Field>
        <Field label="Half spread $"><Num label="Half the bid/ask spread per share" value={inp.halfSpread} onChange={(v) => u({ halfSpread: Math.max(0, v ?? 0) })} step={0.01} w="w-16" /></Field>
        <Field label="Fee / contract"><Num label="Fee per contract" value={inp.exitFee} onChange={(v) => u({ exitFee: Math.max(0, v ?? 0), entryFee: Math.max(0, v ?? 0) })} step={0.05} w="w-16" /></Field>
        <Field label="Rate %"><Num label="Risk-free rate, percent" value={inp.rate} onChange={(v) => u({ rate: v ?? 0 })} step={0.25} w="w-16" /></Field>
        <Field label="Price range ±%"><Num label="Price range, percent either side" value={inp.rangePct} onChange={(v) => u({ rangePct: Math.min(90, Math.max(1, v ?? 20)) })} w="w-16" /></Field>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-2">
        <p className="mb-2 rounded border border-warn/40 bg-warn/10 px-2 py-1 text-[11px]">
          <b>Theoretical simulation</b> — Black-Scholes values from your volatility inputs, not historical option quotes. Dollar outcomes per scenario only; no probability of profit is implied, and a stock signal’s win rate says nothing about this option.
        </p>

        {(spot > inp.strike * 1.5 || spot < inp.strike / 1.5) && (
          <p className="mb-2 rounded border border-danger/40 bg-danger/10 px-2 py-1 text-[11px]" role="alert">
            {symbol} at {px(spot)} is far from the {px(inp.strike)} strike — check the symbol and stock price{inp.spot === null && chartSpot !== undefined ? ' (the price comes from the active chart)' : ''}.
          </p>
        )}
        <div className="mb-3 grid grid-cols-2 gap-x-4 gap-y-1 text-[12px] sm:grid-cols-4 lg:grid-cols-8">
          {[
            ['Position', `${inp.quantity} × ${symbol} ${shortDay(inp.expiry)} ${px(inp.strike)} ${inp.type}`],
            ['Cost (with fees)', fmtMoney(model.cost)],
            ['Days to expiry', expired ? 'expired' : String(Math.round(model.T * 365))],
            ['Model mid now', `${px(model.markNow)} @ ${(model.ivNow * 100).toFixed(0)}% IV`],
            ['Your bid → IV', inp.bid === null ? '—' : Number.isFinite(model.bidIv) ? `${(model.bidIv * 100).toFixed(1)}%` : 'outside model bounds'],
            ['Δ shares / θ per day', `${(model.g.delta * inp.quantity * 100).toFixed(0)} / ${signed(model.g.theta * inp.quantity * 100)}`],
            ['Vega per IV point', signed(model.g.vega * inp.quantity * 100)],
            ['Breakeven at expiry', px(model.breakeven)],
          ].map(([k, v]) => (
            <div key={k}><div className="text-[10px] uppercase text-faint">{k}</div><div className="font-semibold tabular-nums">{v}</div></div>
          ))}
        </div>
        {inp.bid !== null && Number.isFinite(model.bidIv) && Math.abs(model.bidIv * 100 - model.ivNow * 100) >= 1 && (
          <p className="mb-2 text-[11px] text-dim">
            Your bid implies {(model.bidIv * 100).toFixed(1)}% volatility (mid = bid + half spread).{' '}
            <button className="underline hover:text-text" onClick={() => u(model.market.earningsDate && now >= model.market.earningsDate ? { ivAfter: Number((model.bidIv * 100).toFixed(1)) } : { ivBefore: Number((model.bidIv * 100).toFixed(1)) })}>Use it</button>
          </p>
        )}

        <div className="section-title px-0">Compare plans on</div>
        <div className="mb-1 flex flex-wrap items-center gap-1" role="group" aria-label="Scenario date">
          {model.dates.map((d) => (
            <button key={d} className="btn-ghost h-7" data-active={d === date} aria-pressed={d === date} onClick={() => setDateSel(d)}>
              {shortDay(d)}
              {d === model.market.earningsDate ? ' · post-earnings' : d === inp.expiry ? ' · expiry' : d === now ? ' · today' : ''}
            </button>
          ))}
        </div>
        <p className="mb-1 text-[10px] text-faint">Volatility on {shortDay(date)}: {(ivOn(model.market, date) * 100).toFixed(0)}%. Each cell: dollar P/L, then capital remaining (cash + what the open contracts would sell for). Capital before the trade: {fmtMoney(model.capital, 0)}.</p>
        <table className="table mb-4">
          <thead>
            <tr>
              <th>{symbol} at</th>
              <th className="text-right">Option mid</th>
              {model.plans.map((p) => <th key={p.id} className="text-right">{p.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {model.prices.map((S) => (
              <tr key={S} className={S === price ? 'bg-raised' : ''}>
                <td><button className="tabular-nums hover:text-accent" onClick={() => setPriceSel(S)} aria-label={`Use ${px(S)} for the volatility table`}>{px(S)}</button> <span className="text-[10px] text-faint">{rowLabel(S)}</span></td>
                <td className="text-right tabular-nums text-dim">{px(model.at({ kind: 'hold' }, S, date).mark)}</td>
                {model.plans.map((p) => {
                  const r = model.at(p.plan, S, date);
                  return (
                    <td key={p.id} className="text-right tabular-nums">
                      <span className="font-semibold" style={{ color: pnlColor(r.pnl) }}>{signed(r.pnl)}</span>
                      <span className="ml-1 text-[10px] text-faint">{fmtMoney(r.capital, 0)}</span>
                      {p.plan.kind === 'sellAtLimit' && <span className="ml-1 text-[10px] text-faint">{r.filled ? 'filled' : 'not filled'}</span>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>

        <div className="section-title px-0">P/L across prices and dates</div>
        <div className="mb-1 flex flex-wrap gap-1" role="group" aria-label="Plan">
          {model.plans.map((p) => (
            <button key={p.id} className="btn-ghost h-7" data-active={p.id === plan.id} aria-pressed={p.id === plan.id} onClick={() => setPlanId(p.id)}>{p.label}</button>
          ))}
        </div>
        <table className="table mb-4">
          <thead>
            <tr>
              <th>{symbol} at</th>
              {model.dates.map((d) => <th key={d} className="text-right">{shortDay(d)}<div className="text-[9px] font-normal text-faint">IV {(ivOn(model.market, d) * 100).toFixed(0)}%</div></th>)}
            </tr>
          </thead>
          <tbody>
            {model.prices.map((S) => (
              <tr key={S}>
                <td className="tabular-nums">{px(S)} <span className="text-[10px] text-faint">{rowLabel(S)}</span></td>
                {model.dates.map((d) => {
                  const r = model.at(plan.plan, S, d);
                  return (
                    <td key={d} className="text-right tabular-nums" style={{ color: pnlColor(r.pnl) }} title={`Capital ${fmtMoney(r.capital, 0)} · option mid ${px(r.mark)} · ${r.openContracts} open`}>
                      {signed(r.pnl)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>

        <div className="section-title px-0">Post-earnings volatility · {symbol} at {px(price)} on {shortDay(date)}</div>
        {model.market.earningsDate && date >= model.market.earningsDate ? (
          <table className="table mb-2">
            <thead>
              <tr>
                <th>IV after earnings</th>
                <th className="text-right">Option mid</th>
                {model.plans.map((p) => <th key={p.id} className="text-right">{p.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {ivList.map((iv) => {
                const m = { ...model.market, ivAfter: iv / 100 };
                return (
                  <tr key={iv}>
                    <td>{iv}%</td>
                    <td className="text-right tabular-nums text-dim">{px(model.at({ kind: 'hold' }, price, date, m).mark)}</td>
                    {model.plans.map((p) => {
                      const r = model.at(p.plan, price, date, m);
                      return (
                        <td key={p.id} className="text-right tabular-nums">
                          <span className="font-semibold" style={{ color: pnlColor(r.pnl) }}>{signed(r.pnl)}</span>
                          <span className="ml-1 text-[10px] text-faint">{fmtMoney(r.capital, 0)}</span>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <p className="mb-2 text-[11px] text-faint">{model.market.earningsDate ? 'Pick a date on or after earnings above.' : 'Enter the first session after earnings to compare post-earnings volatility.'} Click a price in the plan table to change the price used here.</p>
        )}

        <p className="mt-2 text-[10px] text-faint">
          Rules: exits fill at model mid − half spread, less the fee per contract; a contract worth nothing expires without a fee. The limit counts as filled only when the modelled bid reaches it at that price and date — an earlier touch that reversed is not modelled. European-style valuation (calls on stocks without large dividends match American value). Volatility switches from the pre- to the post-earnings figure on the earnings session; the earnings gap itself is the price axis. Informational tool — analysis, not investment advice.
        </p>
      </div>
    </div>
  );
}
