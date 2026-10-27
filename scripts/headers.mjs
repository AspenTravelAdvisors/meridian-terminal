/** Security headers shared by the Vercel build output and the self-host server. */
export const csp = [
  "default-src 'self'",
  // 'unsafe-eval': Meridian Script runs user studies via new Function inside a sandboxed worker;
  // jsdelivr hosts the lazily-loaded Monaco editor.
  "script-src 'self' 'unsafe-eval' https://cdn.jsdelivr.net",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com",
  "font-src 'self' data: https://cdn.jsdelivr.net https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  // live crypto streams connect directly from the browser
  "connect-src 'self' https://cdn.jsdelivr.net wss://data-stream.binance.vision wss://stream.binance.com:9443",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

export const security = {
  'Content-Security-Policy': csp,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
};
