import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type Bar, computeStudy, defaultsOf, resolveConfig, sequential } from '../src';
import { type Countdown, type SetupInfo, newCountdown, shouldRecycle } from '../src/studies/demark/common';
import { arbBars, barsFromCloses } from './helpers';

const DEF = defaultsOf(sequential);

/** Closes: rise 10→15 over bars 0–5, then a steady 0.5 decline. Traced by hand in the comments below. */
function decline(n = 31): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(i <= 5 ? 10 + i : 15 - 0.5 * (i - 5));
  return out;
}

describe('DeMark-style Sequential — hand-computed fixture', () => {
  const bars = barsFromCloses(decline());
  const r = computeStudy(sequential, DEF, bars);

  it('starts the buy setup on the bearish flip bar (bar 8) and counts 1…9 consecutively', () => {
    // bar 8: C[7]=14 > C[3]=13 and C[8]=13.5 < C[4]=14 → bearish flip, setup bar 1
    for (let i = 0; i < 8; i++) expect(r.lines.setup[i]).toBe(0);
    for (let k = 1; k <= 9; k++) expect(r.lines.setup[7 + k]).toBe(-k);
    // extension keeps counting while C < C[i-4]
    expect(r.lines.setup[17]).toBe(-10);
  });

  it('fires SEQ_BUY_SETUP_9 and perfection at bar 16', () => {
    const at16 = r.signals.filter((s) => s.i === 16).map((s) => s.id);
    expect(at16).toContain('SEQ_BUY_SETUP_9');
    // L8 (bar 15) = 9.5 ≤ min(L6, L7) = min(10.5, 10) → perfected on bar 9
    expect(at16).toContain('SEQ_BUY_SETUP_PERFECTED');
    const nine = r.markers.find((m) => m.i === 16 && m.text === '9');
    expect(nine?.style).toBe('solid');
  });

  it('sets TDST resistance to the highest true high of the setup bars (14.5)', () => {
    expect(r.lines.tdst_res[15]).toBeNaN();
    expect(r.lines.tdst_res[16]).toBe(14.5);
    expect(r.lines.tdst_res[30]).toBe(14.5);
  });

  it('counts countdown from bar 9 (CD1 = bar 16) and completes 13 on bar 28', () => {
    // C ≤ L[i-2] holds every bar in a 0.5/bar decline: C[i] = C[i-2] − 1 < L[i-2] = C[i-2] − 0.5
    expect(r.lines.countdown[16]).toBe(-1);
    expect(r.lines.countdown[27]).toBe(-12);
    expect(r.lines.countdown[28]).toBe(-13);
    expect(r.signals.find((s) => s.id === 'SEQ_BUY_CD_13')?.i).toBe(28);
    // countdown risk = lowest TL since CD1 minus its TR
    expect(Number.isFinite(r.lines.cdrisk_buy[28])).toBe(true);
  });

  it('defers bar 13 with "+" when the low is above the close of countdown bar 8', () => {
    // CD1…CD12 on bars 16…27 (close of CD8 = C[23] = 6). Then bounce (bars 28–30 don't qualify) and
    // drop on bar 31: C=6.4 ≤ L[29]=6.5 qualifies, but its low 6.2 > 6 → '+' instead of 13.
    const closes = decline(28).concat([7, 8, 8.5, 6.4]);
    const b = barsFromCloses(closes);
    b[31] = { ...b[31], o: 8.5, h: 9, l: 6.2, c: 6.4 };
    const res = computeStudy(sequential, DEF, b);
    const plus = res.markers.filter((m) => m.text === '+').map((m) => m.i);
    expect(plus).toEqual([31]);
    expect(res.lines.countdown[31]).toBe(-12);
    expect(res.signals.some((s) => s.id === 'SEQ_BUY_CD_13')).toBe(false);
  });

  it('cancels the buy countdown when a whole bar trades above TDST resistance', () => {
    // TDST = 14.5. Bar 25 (close 17): true low = min(L 15.5, prior close 16) = 15.5 > 14.5 → cancel.
    const closes = decline(22).concat([14, 15, 16, 17]);
    const res = computeStudy(sequential, DEF, barsFromCloses(closes));
    const cancel = res.signals.find((s) => s.id === 'SEQ_BUY_CD_CANCEL');
    expect(cancel).toBeDefined();
    expect(cancel!.label).toBe('TDST break');
    expect(res.signals.some((s) => s.id === 'SEQ_BUY_CD_13')).toBe(false);
    expect(res.signals.some((s) => s.id === 'TDST_RES_BREAK')).toBe(true);
  });

  it('keeps the countdown when only the close is above TDST (true low still below)', () => {
    // decline(22) has CD1…CD6 on bars 16–21. Bar 23: o=14, c=15, l=13.5 → close 15 > 14.5 but true low 13.5 < 14.5.
    const b = barsFromCloses(decline(22).concat([14, 15]));
    const byDefault = computeStudy(sequential, DEF, b);
    expect(byDefault.signals.some((s) => s.id === 'SEQ_BUY_CD_CANCEL')).toBe(false);
    const byClose = computeStudy(sequential, resolveConfig(sequential, { tdstCancelTest: 'close' }), b);
    expect(byClose.signals.find((s) => s.id === 'SEQ_BUY_CD_CANCEL')?.i).toBe(23);
  });

  it('recycles when the same setup run reaches 22 (and not at 18)', () => {
    // decline(31): setup bar 1 = bar 8, so count 18 = bar 25 and count 22 = bar 29. A 20-bar countdown is still running.
    const cfg = resolveConfig(sequential, { countdownLength: 20 });
    const res = computeStudy(sequential, cfg, bars);
    const rec = res.signals.filter((s) => s.id === 'SEQ_BUY_CD_RECYCLE');
    expect(rec.map((s) => s.i)).toEqual([29]);
    expect(rec[0].label).toBe('setup reached 22');
    // restarted on bar 29, which itself qualifies → CD1
    expect(res.lines.countdown[29]).toBe(-1);
    const off = computeStudy(sequential, resolveConfig(sequential, { countdownLength: 20, recycleOnLongSetup: false }), bars);
    expect(off.signals.some((s) => s.id === 'SEQ_BUY_CD_RECYCLE')).toBe(false);
  });

  it('size recycle window is 1×–2× the original setup by default', () => {
    const cd: Countdown = { ...newCountdown(), active: true, size: 10 };
    const setup = (size: number) => ({ size }) as SetupInfo;
    expect(shouldRecycle(DEF as never, cd, setup(9.9))).toBe(false);
    expect(shouldRecycle(DEF as never, cd, setup(18))).toBe(true); // was outside the old 1.618 window
    expect(shouldRecycle(DEF as never, cd, setup(20))).toBe(true);
    expect(shouldRecycle(DEF as never, cd, setup(20.1))).toBe(false);
  });

  describe('intersection', () => {
    // Setup bar 1 = bar 8 (as above). Bar 15 (setup bar 8) gaps down to [5.5, 7] and the decline continues, so neither
    // bar 15 nor bar 16 overlaps a setup bar three or more bars earlier. Bar 17 [4.5, 6] vs bars 8–14 (lows ≥ 10): no.
    // Bar 18 [4, 5.5] vs bars 8–15: its high 5.5 reaches bar 15's low 5.5 → intersection on bar 18.
    const closes = decline(15).concat([6, 5.5, 5, 4.5, 4, 3.5, 3]);
    const b = barsFromCloses(closes);
    b[15] = { ...b[15], o: 6.5, h: 7, l: 5.5, c: 6 };
    const run = (intersectionMode: string) => computeStudy(sequential, resolveConfig(sequential, { intersectionMode }), b);

    it('off (default): countdown starts on setup bar 9 as usual', () => {
      const r0 = run('off');
      expect(r0.lines.countdown[16]).toBe(-1); // C 5.5 ≤ L[14] 10
      expect(r0.lines.countdown[18]).toBe(-3);
    });

    it('postpone: countdown starts on the first intersecting bar, which can itself count', () => {
      const rp = run('postpone');
      expect(rp.lines.countdown[16]).toBe(0);
      expect(rp.lines.countdown[17]).toBe(0);
      expect(rp.lines.countdown[18]).toBe(-1); // C 4.5 ≤ L[16] 5
      expect(rp.markers.some((m) => m.i === 18 && m.text === '—')).toBe(true);
    });

    it('cancel: no countdown from a setup that has not intersected by bar 9', () => {
      const rc = run('cancel');
      expect([...rc.lines.countdown].every((v) => v === 0)).toBe(true);
    });
  });

  it('aggressive countdown uses L ≤ L[i-2]', () => {
    const cfg = resolveConfig(sequential, { countdownMode: 'aggressive' });
    const res = computeStudy(sequential, cfg, bars);
    expect(res.signals.some((s) => s.id === 'SEQ_BUY_CD_13')).toBe(true);
  });

  it('sell side mirrors the buy side exactly', () => {
    const mirrored: Bar[] = bars.map((b) => ({ t: b.t, o: 100 - b.o, h: 100 - b.l, l: 100 - b.h, c: 100 - b.c, v: b.v }));
    const res = computeStudy(sequential, DEF, mirrored);
    for (let i = 0; i < bars.length; i++) {
      expect(res.lines.setup[i] + 0).toBe(-r.lines.setup[i] + 0);
      expect(res.lines.countdown[i] + 0).toBe(-r.lines.countdown[i] + 0);
    }
    expect(res.signals.find((s) => s.id === 'SEQ_SELL_CD_13')?.i).toBe(28);
    expect(res.lines.tdst_sup[20]).toBeCloseTo(100 - 14.5, 10);
  });

  it('exposes every ⚠ VERIFY knob as an input', () => {
    for (const k of ['tdstMode', 'cd13Qualifier', 'recycleFactor', 'recycleMode', 'recycleSetupCount', 'cancelOnTdstBreak', 'tdstCancelTest', 'intersectionMode'])
      expect(k in DEF).toBe(true);
    expect(DEF.tdstMode).toBe('allSetupBars');
    expect(DEF.cd13Qualifier).toBe('low_vs_cd8_close');
    expect(DEF.recycleFactor).toBe(2);
  });
});

// ── Independent oracle written directly from INDICATORS.md §1 (default config) ──
function oracle(bars: Bar[]) {
  const n = bars.length;
  const C = bars.map((b) => b.c);
  const H = bars.map((b) => b.h);
  const L = bars.map((b) => b.l);
  const TH = (i: number) => (i > 0 ? Math.max(H[i], C[i - 1]) : H[i]);
  const TL = (i: number) => (i > 0 ? Math.min(L[i], C[i - 1]) : L[i]);
  const buy: number[] = [];
  const sell: number[] = [];
  for (let i = 0; i < n; i++) {
    const bc = i >= 4 && C[i] < C[i - 4];
    const sc = i >= 4 && C[i] > C[i - 4];
    const bf = bc && i >= 5 && C[i - 1] > C[i - 5];
    const sf = sc && i >= 5 && C[i - 1] < C[i - 5];
    const pb = i > 0 ? buy[i - 1] : 0;
    const ps = i > 0 ? sell[i - 1] : 0;
    buy.push(bc ? (pb > 0 ? pb + 1 : bf ? 1 : 0) : 0);
    sell.push(sc ? (ps > 0 ? ps + 1 : sf ? 1 : 0) : 0);
  }
  const setupInfo = (i9: number, isBuy: boolean) => {
    let hi = -Infinity;
    let lo = Infinity;
    for (let k = i9 - 8; k <= i9; k++) {
      hi = Math.max(hi, TH(k));
      lo = Math.min(lo, TL(k));
    }
    return { size: hi - lo, tdst: isBuy ? hi : lo };
  };
  type Cd = { active: boolean; count: number; cd8: number; tdst: number; size: number };
  const lastInfo: Record<'b' | 's', { size: number; tdst: number } | null> = { b: null, s: null };
  const cds: Record<'b' | 's', Cd> = {
    b: { active: false, count: 0, cd8: NaN, tdst: NaN, size: NaN },
    s: { active: false, count: 0, cd8: NaN, tdst: NaN, size: NaN },
  };
  const thirteens: { i: number; side: 'b' | 's' }[] = [];
  for (let i = 0; i < n; i++) {
    const bDone = buy[i] === 9;
    const sDone = sell[i] === 9;
    for (const side of ['b', 's'] as const) {
      const isBuy = side === 'b';
      const cd = cds[side];
      const done = isBuy ? bDone : sDone;
      const oppDone = isBuy ? sDone : bDone;
      // §1.6(b): cancel when the whole bar is beyond TDST (true low above / true high below)
      if (cd.active && (oppDone || (isBuy ? TL(i) > cd.tdst : TH(i) < cd.tdst))) cd.active = false;
      if (done) {
        const info = setupInfo(i, isBuy);
        lastInfo[side] = info;
        if (!cd.active || (info.size >= cd.size && info.size <= 2 * cd.size)) {
          Object.assign(cd, { active: true, count: 0, cd8: NaN, tdst: info.tdst, size: info.size });
        }
      } else if ((isBuy ? buy[i] : sell[i]) === 22 && cd.active && lastInfo[side]) {
        // §1.7: the same-direction setup ran to 22 → restart the countdown on this bar
        Object.assign(cd, { count: 0, cd8: NaN, tdst: lastInfo[side]!.tdst, size: lastInfo[side]!.size });
      }
      if (cd.active && i >= 2 && (isBuy ? C[i] <= L[i - 2] : C[i] >= H[i - 2])) {
        if (cd.count < 12) {
          cd.count++;
          if (cd.count === 8) cd.cd8 = C[i];
        } else if (isBuy ? L[i] <= cd.cd8 : H[i] >= cd.cd8) {
          cd.active = false;
          thirteens.push({ i, side });
        }
      }
    }
  }
  return { buy, sell, thirteens };
}

describe('DeMark-style Sequential — matches the independent oracle on random data', () => {
  it('setup counts and countdown 13s agree bar-for-bar', () => {
    fc.assert(
      fc.property(arbBars(30, 400), (bars) => {
        const r = computeStudy(sequential, DEF, bars);
        const o = oracle(bars);
        for (let i = 0; i < bars.length; i++) {
          const expected = o.sell[i] > 0 ? o.sell[i] : o.buy[i] > 0 ? -o.buy[i] : 0;
          if (r.lines.setup[i] !== expected) return false;
        }
        const got = r.signals
          .filter((s) => s.id === 'SEQ_BUY_CD_13' || s.id === 'SEQ_SELL_CD_13')
          .map((s) => `${s.i}${s.id === 'SEQ_BUY_CD_13' ? 'b' : 's'}`)
          .sort();
        const exp = o.thirteens.map((t) => `${t.i}${t.side}`).sort();
        expect(got).toEqual(exp);
        return true;
      }),
      { numRuns: 300 },
    );
  });
});
