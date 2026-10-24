/**
 * iOS keeps the layout viewport full-height when the keyboard opens and just covers the page.
 * Mirror the visible area into CSS vars so #app shrinks to sit above the keyboard.
 */
export function trackVisualViewport(): void {
  const vv = window.visualViewport;
  if (!vv) return;
  const style = document.documentElement.style;
  const update = () => {
    if (vv.scale > 1.01) return; // pinch-zoomed: keep the layout as it is
    style.setProperty('--vv-height', `${vv.height}px`);
    style.setProperty('--vv-top', `${vv.offsetTop}px`);
  };
  vv.addEventListener('resize', update);
  vv.addEventListener('scroll', update);
  update();
}
