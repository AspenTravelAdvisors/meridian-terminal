import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { handle } from './index';

/** Convert a Node request to a Web Request (used by Vercel's Node launcher, Vite dev and `pnpm serve`). */
export function toWebRequest(req: IncomingMessage, base = 'http://localhost'): Request {
  const host = req.headers['x-forwarded-host'] ?? req.headers.host ?? new URL(base).host;
  const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0] ?? (base.startsWith('https') ? 'https' : 'http');
  const url = new URL(req.url ?? '/', `${proto}://${host}`);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
    else headers.set(k, v);
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  return new Request(url, {
    method: req.method,
    headers,
    body: hasBody ? (Readable.toWeb(req) as unknown as ReadableStream) : undefined,
    // @ts-expect-error — Node's fetch requires duplex for streamed request bodies
    duplex: hasBody ? 'half' : undefined,
  });
}

/** Write a Web Response to a Node response, streaming the body (the analyst streams text). */
export async function sendWebResponse(res: ServerResponse, r: Response): Promise<void> {
  res.statusCode = r.status;
  r.headers.forEach((v, k) => res.setHeader(k, v));
  if (!r.body) {
    res.end();
    return;
  }
  const reader = r.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(value);
  }
  res.end();
}

/** Node (req, res) handler — the default export of the bundled Vercel function. */
export default async function nodeHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    await sendWebResponse(res, await handle(toWebRequest(req)));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: e instanceof Error ? e.message : 'internal error' }));
  }
}
