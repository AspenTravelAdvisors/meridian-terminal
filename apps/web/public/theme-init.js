// Applied before first paint so the saved theme never flashes (external file: the CSP disallows inline scripts).
try {
  var t = JSON.parse(localStorage.getItem('meridian.settings') || '{}').state;
  t = t && t.theme;
  if (t === 'light' || (t === 'system' && matchMedia('(prefers-color-scheme: light)').matches)) document.documentElement.dataset.theme = 'light';
} catch (e) {}
