import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// A tab left open across a deploy asks for chunks the new build no longer has: reload once to pick up the new build.
addEventListener('vite:preloadError', (e) => {
  try {
    const last = Number(sessionStorage.getItem('meridian.reloadedAt') ?? 0);
    if (Date.now() - last < 30_000) return; // already tried: let the startup guard explain
    sessionStorage.setItem('meridian.reloadedAt', String(Date.now()));
  } catch {
    return; // storage blocked: no way to stop a reload loop, so leave it to the startup guard
  }
  e.preventDefault();
  location.reload();
});

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* offline cache is optional */
    });
  });
}
