import { flushSync } from 'svelte';

export type Tab = 'files' | 'editor' | 'terminal' | 'preview' | 'logs';

export const ui = $state({ tab: 'files' as Tab, toast: '', quickOpen: false });

let toastTimer: ReturnType<typeof setTimeout> | undefined;

/** A short message above the tab bar. */
export function toast(message: string): void {
  ui.toast = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (ui.toast = ''), 4000);
}

/** Renders quick-open synchronously so its input can take focus inside the tap: iOS only shows the keyboard then. */
export function openQuickOpen(): void {
  flushSync(() => (ui.quickOpen = true));
}
