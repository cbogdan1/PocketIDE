import type { Terminal } from '@xterm/xterm';
import { diffInput, keySequence, straighten, withModifiers, type Mods } from './termio.ts';

/**
 * Keyboard input for xterm.js, built for the iOS keyboard. xterm's own handling of its hidden textarea
 * duplicates or drops characters when predictive text, autocorrect or dictation rewrite words already
 * typed, so we take over the textarea's events: special keys become escape sequences, and typed text is
 * sent as the difference between the field's old and new contents (backspaces plus the new text).
 */
export class TermInput {
  private composing = false;
  /** What the field held after the last change we sent. */
  private last = '';

  constructor(
    private term: Terminal,
    private send: (data: string) => void,
    /** Ctrl/Alt latched on the extra key row; they apply to the next key and are then released. */
    private sticky: { get(): Mods; clear(): void },
  ) {
    const field = term.textarea!;
    const attrs = { autocorrect: 'off', autocapitalize: 'off', autocomplete: 'off', spellcheck: 'false', writingsuggestions: 'false' };
    for (const [name, value] of Object.entries(attrs)) field.setAttribute(name, value);
    // Capture on xterm's root runs before xterm's own listeners on the textarea, which never see these events.
    const take = <K extends keyof HTMLElementEventMap>(type: K, handler: (e: HTMLElementEventMap[K]) => void) =>
      term.element!.addEventListener(type, (e) => {
        if (e.target !== field) return;
        e.stopPropagation();
        handler(e);
      }, true);
    take('keydown', (e) => this.keydown(e));
    take('keypress', () => {}); // text arrives through 'input'
    take('keyup', () => {});
    take('compositionstart', () => (this.composing = true));
    take('compositionupdate', () => {});
    take('compositionend', () => {
      this.composing = false;
      this.sync();
    });
    take('input', () => {
      if (!this.composing) this.sync();
    });
    // xterm keeps 'paste' (bracketed paste) and focus handling.
  }

  private keydown(e: KeyboardEvent) {
    if (e.isComposing || e.keyCode === 229 || e.metaKey) return; // IME at work, or Cmd shortcuts like Cmd+V
    const sticky = this.sticky.get();
    const mods: Mods = { shift: e.shiftKey, alt: e.altKey || sticky.alt, ctrl: e.ctrlKey || sticky.ctrl };
    // With text in the field, Backspace edits it and the change is sent from 'input'.
    let seq = e.key === 'Backspace' && this.last && !mods.ctrl && !mods.alt ? undefined : keySequence(e.key, mods, this.appCursor);
    if (seq === undefined && (mods.ctrl || mods.alt)) {
      // Option+letter on a Mac keyboard types a symbol; the physical key is what Alt means here.
      const letter = /^Key([A-Z])$/.exec(e.code)?.[1].toLowerCase();
      const ch = e.altKey && letter ? letter : e.key;
      if (ch.length === 1) seq = withModifiers(ch, mods);
    }
    if (seq === undefined) return;
    e.preventDefault();
    this.sticky.clear();
    this.reset();
    this.send(seq);
  }

  private sync() {
    const field = this.term.textarea!;
    const { deleted, inserted } = diffInput(this.last, field.value);
    this.last = field.value;
    let text = straighten(inserted).replace(/\n/g, '\r');
    const sticky = this.sticky.get();
    if (text && (sticky.ctrl || sticky.alt)) {
      text = withModifiers(text[0], sticky) + text.slice(1);
      this.sticky.clear();
    }
    const out = '\x7f'.repeat(deleted) + text;
    if (out) this.send(out);
    // A new line starts fresh suggestions; and the field shouldn't grow without bound.
    if (text.includes('\r') || field.value.length > 80) this.reset();
  }

  /** Empties the field: after special keys the shell's line no longer matches what it holds. */
  reset() {
    if (this.composing) return;
    this.term.textarea!.value = '';
    this.last = '';
  }

  /** A key from the extra key row, with the latched modifiers. */
  press(key: string, mods: Mods = {}) {
    const sticky = this.sticky.get();
    const all = { shift: mods.shift, alt: mods.alt || sticky.alt, ctrl: mods.ctrl || sticky.ctrl };
    const seq = keySequence(key, all, this.appCursor) ?? withModifiers(key, all);
    this.sticky.clear();
    this.reset();
    this.send(seq);
  }

  private get appCursor() {
    return this.term.modes.applicationCursorKeysMode;
  }
}
