/** The Forward Cone's status values, put into the two sentences a reader needs: what the cases say, and whether to trust it. */
export interface ConeReading {
  lean: 'up' | 'down' | 'none';
  headline: string;
  /** good: calibrated and beat the all-bars forecast · range: calibrated, no directional edge · poor: miscalibrated · unknown: too few scored */
  trust: 'good' | 'range' | 'poor' | 'unknown';
  verdict: string;
}

/** Scored forecasts needed before the scorecard is read out. */
export const CONE_MIN_SCORED = 50;
/** An 80% range is called honest when it held between these shares of the time. */
const COVER_OK: [number, number] = [0.72, 0.88];

const pct = (v: number) => `${Math.round(100 * v)}%`;
const n = (v: unknown): number => (typeof v === 'number' ? v : NaN);

export function coneReading(values: Record<string, unknown> | null | undefined): ConeReading | null {
  const v = values ?? {};
  const pUp = n(v.pUp);
  if (!Number.isFinite(pUp)) return null;
  const H = n(v.horizon);
  const baseUp = n(v.baseUp);
  const dir = n(v.dir);
  const lean = dir > 0 ? 'up' : dir < 0 ? 'down' : 'none';
  const headline =
    n(v.level) === 3
      ? `No similar state has enough history: this is the plain range of all bars (${pct(pUp)} closed higher ${H} bars later)`
      : lean === 'down'
        ? `Leans down: ${pct(1 - pUp)} of similar bars closed lower ${H} bars later (all bars: ${pct(1 - baseUp)})`
        : `${lean === 'up' ? 'Leans up' : 'No lean'}: ${pct(pUp)} of similar bars closed higher ${H} bars later (all bars: ${pct(baseUp)})`;

  const scored = n(v.scored) || 0;
  const cover = n(v.cover80);
  const skill = n(v.skill);
  let trust: ConeReading['trust'];
  let verdict: string;
  if (scored < CONE_MIN_SCORED || !Number.isFinite(cover)) {
    trust = 'unknown';
    verdict = `Only ${scored} forecasts scored so far: too few to judge.`;
  } else if (cover < COVER_OK[0] || cover > COVER_OK[1]) {
    trust = 'poor';
    verdict = cover < COVER_OK[0] ? `On this chart the 80% range held only ${pct(cover)} of the time: it has been too narrow here.` : `On this chart the 80% range held ${pct(cover)} of the time: it has been too wide here.`;
  } else if (skill > 0.01) {
    trust = 'good';
    verdict = `On this chart the 80% range held ${pct(cover)} of the time and the matched forecast beat the all-bars one by ${(100 * skill).toFixed(1)}%.`;
  } else {
    trust = 'range';
    verdict = `On this chart the 80% range held ${pct(cover)} of the time, but matching on state did not beat the all-bars forecast: read it as a volatility range, not a directional call.`;
  }
  return { lean, headline, trust, verdict };
}
