// Injected by PocketIDE into every page it previews (served as /__pocketide/preview.js). It forwards the page's
// errors and warnings to the "Preview console" log, tells the app which address the page is on, and takes its
// Back / Forward / Reload buttons. It changes nothing else about the page.
(() => {
  if (window.__pocketide) return;
  window.__pocketide = true;

  const queue = [];
  let timer;
  const flush = () => {
    timer = undefined;
    const body = JSON.stringify(queue.splice(0));
    if (!navigator.sendBeacon?.('/__pocketide/console', body)) {
      fetch('/__pocketide/console', { method: 'POST', body, keepalive: true }).catch(() => {});
    }
  };
  const report = (level, text) => {
    if (queue.length < 50) queue.push({ level, text: String(text).slice(0, 8000) });
    timer ??= setTimeout(flush, 200);
  };
  const show = (value) => {
    if (value instanceof Error) return value.stack || String(value);
    if (typeof value !== 'object' || value === null) return String(value);
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  };
  for (const level of ['error', 'warn']) {
    const original = console[level];
    console[level] = function (...args) {
      try {
        report(level, args.map(show).join(' '));
      } catch {
        // never break the page's own logging
      }
      return original.apply(this, args);
    };
  }
  addEventListener('error', (e) => {
    if (e.error || e.message) report('error', e.error?.stack || `${e.message} (${e.filename}:${e.lineno}:${e.colno})`);
  });
  addEventListener('unhandledrejection', (e) => report('error', `Unhandled promise rejection: ${show(e.reason)}`));

  if (parent === window) return;
  const where = () =>
    parent.postMessage({ pocketide: 'location', path: location.pathname + location.search + location.hash, title: document.title }, '*');
  for (const method of ['pushState', 'replaceState']) {
    const original = history[method];
    history[method] = function (...args) {
      const result = original.apply(this, args);
      where();
      return result;
    };
  }
  addEventListener('popstate', where);
  addEventListener('hashchange', where);
  addEventListener('DOMContentLoaded', where);
  where();
  addEventListener('message', (e) => {
    if (e.source !== parent || typeof e.data?.pocketide !== 'string') return;
    if (e.data.pocketide === 'back') history.back();
    else if (e.data.pocketide === 'forward') history.forward();
    else if (e.data.pocketide === 'reload') location.reload();
  });
})();
