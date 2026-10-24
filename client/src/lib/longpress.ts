import type { Action } from 'svelte/action';

/** Calls `callback` after a 500ms press that doesn't move (or on right-click). */
export const longpress: Action<HTMLElement, () => void> = (node, callback) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let start = { x: 0, y: 0 };
  let fired = false;

  const fire = () => {
    fired = true;
    callback();
  };
  const cancel = () => clearTimeout(timer);
  const down = (e: PointerEvent) => {
    fired = false;
    start = { x: e.clientX, y: e.clientY };
    timer = setTimeout(fire, 500);
  };
  const move = (e: PointerEvent) => {
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) cancel();
  };
  // The click that ends a long press would land on the menu that just opened (and close it).
  const swallowClick = (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
  };
  const up = (e: PointerEvent) => {
    cancel();
    if (!fired || e.pointerType !== 'mouse') return;
    addEventListener('click', swallowClick, { capture: true, once: true });
    setTimeout(() => removeEventListener('click', swallowClick, { capture: true }), 400);
  };
  const touchend = (e: TouchEvent) => {
    if (fired) e.preventDefault(); // no click at all after a touch long press
  };
  const contextmenu = (e: Event) => {
    e.preventDefault();
    if (!fired) fire();
  };

  node.addEventListener('pointerdown', down);
  node.addEventListener('pointermove', move);
  node.addEventListener('pointerup', up);
  node.addEventListener('pointercancel', cancel);
  node.addEventListener('touchend', touchend, { passive: false });
  node.addEventListener('contextmenu', contextmenu);
  return {
    update(next) {
      callback = next;
    },
    destroy() {
      cancel();
      node.removeEventListener('pointerdown', down);
      node.removeEventListener('pointermove', move);
      node.removeEventListener('pointerup', up);
      node.removeEventListener('pointercancel', cancel);
      node.removeEventListener('touchend', touchend);
      node.removeEventListener('contextmenu', contextmenu);
    },
  };
};
