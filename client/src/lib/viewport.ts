/**
 * iOS keeps the layout viewport full-height when the keyboard opens and just covers the page.
 * Mirror the visible area into CSS vars so #app shrinks to sit above the keyboard, and set
 * `html.kb` while the keyboard is up (the editor's key row replaces the tab bar then).
 */
export function trackVisualViewport(): void {
  const vv = window.visualViewport;
  if (!vv) return;
  const root = document.documentElement;
  const update = () => {
    if (vv.scale > 1.01) return; // pinch-zoomed: keep the layout as it is
    root.style.setProperty('--vv-height', `${vv.height}px`);
    root.style.setProperty('--vv-top', `${vv.offsetTop}px`);
    root.classList.toggle('kb', window.innerHeight - vv.height > 150);
  };
  vv.addEventListener('resize', update);
  vv.addEventListener('scroll', update);
  update();
}
