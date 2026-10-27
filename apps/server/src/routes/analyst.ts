import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { HttpError, type ServerEnv, body, rateLimit } from '../http';

/**
 * AI Chart Analyst (SPEC §8.4). The model receives STRUCTURED engine output — active signals, levels,
 * study states, the MTF matrix and portfolio exposure — never screenshots, and returns a plain-English
 * briefing with explicit uncertainty. Analysis, not advice.
 */
export const analystBody = z.object({
  kind: z.enum(['chart', 'portfolio']).default('chart'),
  symbol: z.string().max(40).optional(),
  interval: z.string().max(5).optional(),
  question: z.string().max(2000).optional(),
  /** engine/portfolio snapshot assembled by the client */
  context: z.record(z.string(), z.unknown()),
});
export type AnalystRequest = z.infer<typeof analystBody>;

const SYSTEM = `You are Meridian's chart analyst, embedded in a charting and portfolio workstation.

You receive a JSON snapshot produced by Meridian's deterministic indicator engine: DeMark-style exhaustion studies (Sequential, Combo, D-Wave, Range Projection, DeMarker, REI and others), Ichimoku and standard indicators, plus recent signals with how many bars ago they fired, key levels (TDST, risk levels, projections), a multi-timeframe matrix and, for portfolio briefs, positions and risk metrics.

Write a concise briefing for an experienced discretionary trader:
- Lead with a 1–2 sentence summary of the current state.
- Then short sections: "Exhaustion & timing" (setups/countdowns, their stage, perfection, TDST), "Levels to watch" (with the exact numbers from the data), "Timeframe alignment" (agreement or conflict across timeframes), and "What would change the picture" (concrete invalidation conditions).
- For a portfolio brief, cover concentration, positions showing exhaustion signals against the position's direction, and risk metrics.

Rules:
- Use only numbers that appear in the snapshot. Never invent prices, dates, statistics or news. If something needed is missing, say it is not in the data.
- State uncertainty explicitly. These studies are probabilistic exhaustion indicators, not predictions; say how strong or weak the evidence is and where signals disagree.
- If the snapshot marks data as simulated, say so in the first line.
- Refer to studies as "DeMark-style" (e.g. "DeMark-style Sequential"), not by trademarked names alone.
- Do not tell the user to buy, sell or size a position. Close with one line: "Analysis only — not investment advice."
- Plain Markdown, no tables wider than 4 columns, under about 350 words.`;

/** Deterministic briefing used when no API key is configured (and in tests). */
export function ruleBasedBriefing(r: AnalystRequest): string {
  const c = r.context as Record<string, unknown>;
  const lines: string[] = [];
  if (c.simulated) lines.push('> **Simulated data** — this series is generated, not market data.\n');
  lines.push(`### ${r.kind === 'portfolio' ? 'Portfolio brief' : `${r.symbol ?? 'Chart'} · ${r.interval ?? ''}`} (rule-based)`);
  lines.push('> No `ANTHROPIC_API_KEY` is configured on the server, so this summary is assembled mechanically from the engine output.\n');
  const chips = (c.chips as { text: string; dir: string }[] | undefined) ?? [];
  if (chips.length) lines.push(`**Current state:** ${chips.map((x) => `${x.text} (${x.dir})`).join(', ')}.`);
  const sigs = (c.recentSignals as { id: string; barsAgo: number; dir: string; price?: number }[] | undefined) ?? [];
  if (sigs.length) {
    lines.push('\n**Recent signals**');
    for (const s of sigs.slice(0, 8)) lines.push(`- ${s.id.replace(/_/g, ' ')} — ${s.barsAgo} bar(s) ago (${s.dir})${s.price ? ` @ ${s.price.toFixed(2)}` : ''}`);
  }
  const lv = (c.levels as Record<string, number | null> | undefined) ?? {};
  const levelLines = Object.entries(lv).filter(([, v]) => typeof v === 'number');
  if (levelLines.length) {
    lines.push('\n**Levels to watch**');
    for (const [k, v] of levelLines) lines.push(`- ${k}: ${(v as number).toFixed(2)}`);
  }
  const mtf = (c.mtf as { interval: string; label: string; score: number }[] | undefined) ?? [];
  if (mtf.length) {
    const bull = mtf.filter((m) => m.score > 0.05).length;
    const bear = mtf.filter((m) => m.score < -0.05).length;
    lines.push(`\n**Timeframe alignment:** ${mtf.map((m) => `${m.interval} ${m.label}`).join(' · ')} — ${bull} buy-side vs ${bear} sell-side exhaustion readings.`);
  }
  if (!chips.length && !sigs.length) lines.push('No active exhaustion states or recent signals in the snapshot.');
  lines.push('\nAnalysis only — not investment advice.');
  return lines.join('\n');
}

function textStream(make: (push: (s: string) => void) => Promise<void>): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    async start(ctrl) {
      try {
        await make((s) => ctrl.enqueue(enc.encode(s)));
      } catch (e) {
        ctrl.enqueue(enc.encode(`\n\n_⚠ Analyst error: ${e instanceof Anthropic.APIError ? `${e.status ?? ''} ${e.message}` : e instanceof Error ? e.message : String(e)}_`));
      } finally {
        ctrl.close();
      }
    },
  });
}

/** POST /api/analyst — streams Markdown (text/plain). */
export async function analystRoute(req: Request, env: ServerEnv): Promise<Response> {
  rateLimit(req, 'analyst', 10);
  const r = await body(req, analystBody, 80_000);
  const snapshot = JSON.stringify(r.context);
  if (snapshot.length > 60_000) throw new HttpError(413, 'context snapshot too large');
  const headers = { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

  if (!env.ANTHROPIC_API_KEY) return new Response(ruleBasedBriefing(r), { headers: { ...headers, 'X-Meridian-Analyst': 'rule-based' } });

  const model = env.ANTHROPIC_MODEL || 'claude-opus-5-5';
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 2, timeout: 120_000 });
  const user = [
    `Briefing type: ${r.kind}${r.symbol ? ` · symbol ${r.symbol}` : ''}${r.interval ? ` · timeframe ${r.interval}` : ''}`,
    r.question ? `User question: ${r.question}` : 'Give the standard briefing.',
    '<snapshot>',
    snapshot,
    '</snapshot>',
  ].join('\n');

  const stream = textStream(async (push) => {
    const s = client.beta.messages.stream({
      model,
      max_tokens: 16000,
      system: SYSTEM,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      // Server-side refusal fallback: a policy decline is retried on the server-defined fallback model.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      messages: [{ role: 'user', content: user }],
    });
    s.on('text', (t) => push(t));
    const final = await s.finalMessage();
    if (final.stop_reason === 'refusal') push('\n\n_The analyst declined to produce this briefing._');
    else if (final.stop_reason === 'max_tokens') push('\n\n_…briefing truncated._');
  });
  return new Response(stream, { headers: { ...headers, 'X-Meridian-Analyst': model } });
}
