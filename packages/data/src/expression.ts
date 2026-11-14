import { type Bar, tzOffsetMs } from '@meridian/engine';
import { parseSymbol } from './symbols';
import type { Interval } from './types';

/**
 * Symbol expressions: charts of arithmetic on other symbols, such as a ratio (SPY/RSP, ETHUSDT/BTCUSDT), a spread
 * (XOM - CVX) or a basket ((XLY + XLK)/2). See docs/ARCHITECTURE.md § "Symbol expressions".
 *
 * Grammar: operands are symbols or positive numbers; operators are + − * / with the usual precedence; parentheses group.
 * `+` and `-` need a space on each side so hyphenated tickers (BRK-B, BTC-USD) stay tickers.
 */
export type ExprNode = { k: 'sym'; symbol: string } | { k: 'num'; v: number } | { k: 'op'; op: Op; a: ExprNode; b: ExprNode };
type Op = '+' | '-' | '*' | '/';

export const EXPR_MAX_SYMBOLS = 6;
export const EXPR_MAX_LENGTH = 120;

export class ExpressionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExpressionError';
  }
}

/** Characters that may appear inside one symbol. `-` only joins two symbol characters ("BRK-B"). */
const SYM_CHAR = /[A-Za-z0-9.^=:_]/;

type Tok = { k: 'sym'; s: string } | { k: 'num'; v: number } | { k: 'op'; op: Op } | { k: '(' } | { k: ')' };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t') {
      i++;
      continue;
    }
    if (ch === '(' || ch === ')') {
      out.push({ k: ch });
      i++;
      continue;
    }
    if (ch === '*' || ch === '/' || ch === '+' || ch === '-') {
      out.push({ k: 'op', op: ch });
      i++;
      continue;
    }
    if (SYM_CHAR.test(ch)) {
      let j = i + 1;
      while (j < src.length && (SYM_CHAR.test(src[j]) || (src[j] === '-' && SYM_CHAR.test(src[j - 1]) && j + 1 < src.length && SYM_CHAR.test(src[j + 1])))) j++;
      const word = src.slice(i, j);
      if (/^\d+(\.\d+)?$/.test(word) || /^\.\d+$/.test(word)) out.push({ k: 'num', v: Number(word) });
      else out.push({ k: 'sym', s: word });
      i = j;
      continue;
    }
    throw new ExpressionError(`unexpected “${ch}” in symbol expression`);
  }
  return out;
}

const PREC: Record<Op, number> = { '+': 1, '-': 1, '*': 2, '/': 2 };

/** Parse an expression and canonicalise each operand (`ethusdt` → `BINANCE:ETHUSDT`). Throws ExpressionError. */
export function parseExpression(raw: string): ExprNode {
  if (raw.length > EXPR_MAX_LENGTH) throw new ExpressionError(`symbol expression is longer than ${EXPR_MAX_LENGTH} characters`);
  const toks = tokenize(raw.trim());
  if (!toks.length) throw new ExpressionError('empty symbol expression');
  let p = 0;
  const primary = (): ExprNode => {
    const t = toks[p];
    if (!t) throw new ExpressionError('symbol expression ends early');
    if (t.k === '(') {
      p++;
      const e = expr(0);
      if (toks[p]?.k !== ')') throw new ExpressionError('missing “)” in symbol expression');
      p++;
      return e;
    }
    if (t.k === 'sym') {
      p++;
      return { k: 'sym', symbol: parseSymbol(t.s).canonical };
    }
    if (t.k === 'num') {
      p++;
      return { k: 'num', v: t.v };
    }
    throw new ExpressionError(t.k === ')' ? 'unexpected “)” in symbol expression' : `“${t.op}” needs a symbol or number before it`);
  };
  const expr = (minPrec: number): ExprNode => {
    let left = primary();
    for (;;) {
      const t = toks[p];
      if (!t || t.k !== 'op' || PREC[t.op] < minPrec) break;
      p++;
      const right = expr(PREC[t.op] + 1);
      left = { k: 'op', op: t.op, a: left, b: right };
    }
    return left;
  };
  const root = expr(0);
  if (p < toks.length) {
    const t = toks[p];
    throw new ExpressionError(t.k === ')' ? 'unexpected “)” in symbol expression' : 'missing operator in symbol expression');
  }
  const syms = expressionSymbols(root);
  if (!syms.length) throw new ExpressionError('a symbol expression needs at least one symbol');
  if (syms.length > EXPR_MAX_SYMBOLS) throw new ExpressionError(`a symbol expression may use at most ${EXPR_MAX_SYMBOLS} symbols`);
  return root;
}

/** True when `raw` is an expression rather than a single symbol. Malformed expressions also count (so they fail loudly). */
export function isExpression(raw: string): boolean {
  const s = raw.trim();
  return /[/*()+]/.test(s) || /(^|\s)-|-(\s|$)/.test(s);
}

/** Unique symbols in order of first appearance; the first one sets the bar times. */
export function expressionSymbols(n: ExprNode, out: string[] = []): string[] {
  if (n.k === 'sym') {
    if (!out.includes(n.symbol)) out.push(n.symbol);
  } else if (n.k === 'op') {
    expressionSymbols(n.a, out);
    expressionSymbols(n.b, out);
  }
  return out;
}

/** Canonical text: `A/B`, `A*2`, `A + B`, `(A + B)/2`. Same expression → same string → same cache key. */
export function printExpression(n: ExprNode): string {
  if (n.k === 'sym') return n.symbol;
  if (n.k === 'num') return String(n.v);
  const side = (c: ExprNode, right: boolean) => {
    const s = printExpression(c);
    if (c.k !== 'op') return s;
    const lower = PREC[c.op] < PREC[n.op] || (right && PREC[c.op] === PREC[n.op]);
    return lower ? `(${s})` : s;
  };
  const glue = n.op === '+' || n.op === '-' ? ` ${n.op} ` : n.op;
  return `${side(n.a, false)}${glue}${side(n.b, true)}`;
}

/** Canonical form of a symbol or expression, or undefined when an expression is malformed. */
export function canonicalSymbol(raw: string): string | undefined {
  if (!isExpression(raw)) return parseSymbol(raw).canonical;
  try {
    return printExpression(parseExpression(raw));
  } catch {
    return undefined;
  }
}

export function evalExpression(n: ExprNode, value: (symbol: string) => number): number {
  switch (n.k) {
    case 'sym':
      return value(n.symbol);
    case 'num':
      return n.v;
    case 'op': {
      const a = evalExpression(n.a, value);
      const b = evalExpression(n.b, value);
      return n.op === '+' ? a + b : n.op === '-' ? a - b : n.op === '*' ? a * b : a / b;
    }
  }
}

const DAY = 86_400_000;

/**
 * The period a bar belongs to, for matching bars across symbols. Intraday bars match on their exact open time. Daily
 * and longer bars match on the local trading day, Monday-based week, month or quarter, because providers stamp them
 * differently (Yahoo at the 09:30 ET open, Binance at 00:00 UTC, monthly bars on the first trading day or the 1st).
 */
export function periodKey(t: number, timezone: string, interval: Interval): number {
  if (interval !== '1D' && interval !== '1W' && interval !== '1M' && interval !== '3M') return t;
  const localDay = Math.floor((t + tzOffsetMs(t, timezone)) / DAY);
  if (interval === '1D') return localDay;
  if (interval === '1W') return Math.floor((localDay + 3) / 7); // day 0 (1970-01-01) was a Thursday
  const d = new Date(localDay * DAY);
  const month = d.getUTCFullYear() * 12 + d.getUTCMonth();
  return interval === '1M' ? month : Math.floor(month / 3);
}

export interface ExpressionSeries {
  bars: readonly Bar[];
  timezone: string;
}

/**
 * Combine bars with an expression. The first symbol sets the bar times. Each other symbol contributes its bar for the
 * same period; when it has none (holiday, weekend, a halt) its last earlier close stands in for open, high, low and
 * close. Bars before every symbol has history are dropped, as are bars whose value is not finite (division by zero).
 *
 * Open, high, low and close are each computed field by field, then high and low are widened to cover open and close.
 * The true intrabar extremes of a ratio are unknowable from OHLC alone; this is the usual charting convention. Volume is
 * zero. A bar is provisional (final: false) when any matched component bar is.
 *
 * Output at bar i depends only on component bars at or before bar i's period: no look-ahead.
 */
export function combineExpressionBars(node: ExprNode, series: Record<string, ExpressionSeries>, interval: Interval): Bar[] {
  const syms = expressionSymbols(node);
  const base = series[syms[0]];
  const others = syms.slice(1).map((s) => ({ s, ...series[s], k: -1 }));
  const out: Bar[] = [];
  const vals: Record<string, { o: number; h: number; l: number; c: number }> = {};
  for (const b of base.bars) {
    const key = periodKey(b.t, base.timezone, interval);
    let ok = true;
    let final = b.final !== false;
    vals[syms[0]] = b;
    for (const x of others) {
      while (x.k + 1 < x.bars.length && periodKey(x.bars[x.k + 1].t, x.timezone, interval) <= key) x.k++;
      if (x.k < 0) {
        ok = false;
        break;
      }
      const ob = x.bars[x.k];
      if (periodKey(ob.t, x.timezone, interval) === key) {
        vals[x.s] = ob;
        if (ob.final === false) final = false;
      } else vals[x.s] = { o: ob.c, h: ob.c, l: ob.c, c: ob.c };
    }
    if (!ok) continue;
    const o = evalExpression(node, (s) => vals[s].o);
    const h = evalExpression(node, (s) => vals[s].h);
    const l = evalExpression(node, (s) => vals[s].l);
    const c = evalExpression(node, (s) => vals[s].c);
    if (!Number.isFinite(o) || !Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(c)) continue;
    out.push({ t: b.t, o, h: Math.max(o, h, l, c), l: Math.min(o, h, l, c), c, v: 0, ...(final ? {} : { final: false as const }) });
  }
  return out;
}
