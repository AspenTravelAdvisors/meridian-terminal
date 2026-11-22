// Applied before first paint so the saved theme never flashes (external file: the CSP disallows inline scripts).
try {
  var t = JSON.parse(localStorage.getItem('meridian.settings') || '{}').state;
  t = t && t.theme;
  if (t === 'light' || (t === 'system' && matchMedia('(prefers-color-scheme: light)').matches)) document.documentElement.dataset.theme = 'light';
} catch (e) {}

// Startup guard. If the app has drawn nothing a few seconds after the page loads (a script failed to load or crashed
// before the first render), show what went wrong and offer a reset that clears the cached app. Saved data is kept.
(function () {
  var errs = [];
  function note(m) {
    if (errs.length < 6) errs.push(String(m).slice(0, 400));
  }
  addEventListener(
    'error',
    function (e) {
      var t = e.target;
      if (t && t !== window && (t.src || t.href)) note('could not load ' + (t.src || t.href));
      else note((e.message || 'error') + (e.filename ? ' (' + e.filename.split('/').pop() + ':' + e.lineno + ')' : ''));
    },
    true,
  );
  addEventListener('unhandledrejection', function (e) {
    var r = e.reason;
    note((r && (r.stack || r.message)) || r);
  });
  function el(tag, css, text) {
    var n = document.createElement(tag);
    n.style.cssText = css;
    if (text) n.textContent = text;
    return n;
  }
  function show() {
    var root = document.getElementById('root');
    if (!root || root.childElementCount || document.getElementById('boot-error')) return;
    var box = el('div', 'position:fixed;inset:0;z-index:99999;overflow:auto;padding:max(24px,env(safe-area-inset-top)) 20px 24px;background:#0b0f14;color:#d6dee7;font:14px/1.5 system-ui,-apple-system,sans-serif');
    box.id = 'boot-error';
    box.appendChild(el('h1', 'font-size:18px;margin:0 0 8px', 'Meridian could not start'));
    box.appendChild(el('p', 'margin:0 0 12px;color:#8b9aab', 'Reset clears the cached copy of the app and reloads it. Your settings, watchlists and portfolio are kept.'));
    var b1 = el('button', 'font:inherit;padding:10px 16px;margin:0 8px 12px 0;border:0;border-radius:6px;background:#38bdf8;color:#0b0f14;font-weight:600', 'Reset and reload');
    b1.onclick = function () {
      var jobs = [];
      if (navigator.serviceWorker) jobs.push(navigator.serviceWorker.getRegistrations().then(function (rs) { return Promise.all(rs.map(function (r) { return r.unregister(); })); }));
      if (window.caches) jobs.push(caches.keys().then(function (ks) { return Promise.all(ks.map(function (k) { return caches.delete(k); })); }));
      Promise.all(jobs).then(
        function () { location.reload(); },
        function () { location.reload(); },
      );
    };
    var b2 = el('button', 'font:inherit;padding:10px 16px;margin:0 0 12px;border:1px solid #2f4255;border-radius:6px;background:transparent;color:#d6dee7', 'Reload');
    b2.onclick = function () { location.reload(); };
    box.appendChild(b1);
    box.appendChild(b2);
    box.appendChild(el('p', 'margin:8px 0 4px;color:#8b9aab', 'Details (a screenshot of this helps):'));
    box.appendChild(el('pre', 'white-space:pre-wrap;word-break:break-word;font:12px/1.45 ui-monospace,Menlo,monospace;background:#111821;border:1px solid #233140;border-radius:6px;padding:10px;margin:0', (errs.length ? errs.join('\n\n') : 'No error was reported: the app script did not run.') + '\n\n' + navigator.userAgent));
    document.body.appendChild(box);
    // if the app does come up after all, get out of the way
    var timer = setInterval(function () {
      if (root.childElementCount) {
        box.remove();
        clearInterval(timer);
      }
    }, 1000);
  }
  addEventListener('load', function () {
    setTimeout(show, 8000);
  });
})();
