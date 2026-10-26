export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    message: string,
    readonly status = 502,
  ) {
    super(`${provider}: ${message}`);
  }
}

const UA = 'Mozilla/5.0 (compatible; MeridianTerminal/0.1; +https://github.com/)';

export async function getJson<T>(provider: string, url: string, fetcher: typeof fetch, opts: { headers?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 8000);
  opts.signal?.addEventListener('abort', () => ctrl.abort());
  try {
    const res = await fetcher(url, { headers: { 'User-Agent': UA, Accept: 'application/json', ...opts.headers }, signal: ctrl.signal });
    if (!res.ok) throw new ProviderError(provider, `HTTP ${res.status}`, res.status === 404 ? 404 : 502);
    return (await res.json()) as T;
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    throw new ProviderError(provider, e instanceof Error ? (e.name === 'AbortError' ? 'timeout' : e.message) : String(e));
  } finally {
    clearTimeout(timer);
  }
}

export async function getText(provider: string, url: string, fetcher: typeof fetch, timeoutMs = 8000): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetcher(url, { headers: { 'User-Agent': UA }, signal: ctrl.signal });
    if (!res.ok) throw new ProviderError(provider, `HTTP ${res.status}`);
    return await res.text();
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    throw new ProviderError(provider, e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(timer);
  }
}
