export interface Mods {
  shift?: boolean;
  alt?: boolean;
  ctrl?: boolean;
}

/** Splits terminal input into messages under the agent's 64 KB limit (16k UTF-16 units is at most 48 KB of UTF-8). */
export function chunkInput(data: string, max = 16_000): string[] {
  const chunks: string[] = [];
  for (let start = 0; start < data.length; ) {
    let end = Math.min(start + max, data.length);
    const last = data.charCodeAt(end - 1);
    if (end < data.length && last >= 0xd800 && last <= 0xdbff) end--; // don't split an emoji's surrogate pair
    chunks.push(data.slice(start, end));
    start = end;
  }
  return chunks;
}

/**
 * How the hidden input field changed: how many characters were removed from its end and what was added.
 * iOS predictive text, autocorrect and dictation replace words that were already typed; sending this
 * difference (as backspaces plus text) keeps the shell's line in step without duplicates.
 */
export function diffInput(before: string, after: string): { deleted: number; inserted: string } {
  let same = 0;
  while (same < before.length && same < after.length && before[same] === after[same]) same++;
  const code = before.charCodeAt(same - 1);
  if (same > 0 && code >= 0xd800 && code <= 0xdbff) same--; // differences inside a surrogate pair
  return { deleted: [...before.slice(same)].length, inserted: after.slice(same) };
}

const SMART: Record<string, string> = { '“': '"', '”': '"', '„': '"', '‘': "'", '’': "'", '‚': "'", '—': '--', '–': '-', '…': '...' };

/** Undoes iOS Smart Punctuation, which would otherwise turn quotes and dashes in commands into look-alikes. */
export const straighten = (text: string) => text.replace(/[“”„‘’‚—–…]/g, (c) => SMART[c]);

const CTRL_SYMBOLS: Record<string, string> = { ' ': '\x00', '@': '\x00', '[': '\x1b', '\\': '\x1c', ']': '\x1d', '^': '\x1e', _: '\x1f', '?': '\x7f' };

/** A typed character with Ctrl and/or Alt held, as xterm encodes it. */
export function withModifiers(ch: string, mods: Mods): string {
  let out = ch;
  if (mods.ctrl) {
    const lower = ch.toLowerCase();
    if (lower >= 'a' && lower <= 'z') out = String.fromCharCode(lower.charCodeAt(0) - 96);
    else out = CTRL_SYMBOLS[ch] ?? ch;
  }
  return mods.alt ? '\x1b' + out : out;
}

const CURSOR: Record<string, string> = { ArrowUp: 'A', ArrowDown: 'B', ArrowRight: 'C', ArrowLeft: 'D', Home: 'H', End: 'F' };
const TILDE: Record<string, number> = {
  Insert: 2, Delete: 3, PageUp: 5, PageDown: 6, F5: 15, F6: 17, F7: 18, F8: 19, F9: 20, F10: 21, F11: 23, F12: 24,
};
const SS3: Record<string, string> = { F1: 'P', F2: 'Q', F3: 'R', F4: 'S' };

/** What xterm sends for a special key (KeyboardEvent.key names); undefined for keys that type text. */
export function keySequence(key: string, mods: Mods, appCursor = false): string | undefined {
  const m = 1 + (mods.shift ? 1 : 0) + (mods.alt ? 2 : 0) + (mods.ctrl ? 4 : 0);
  switch (key) {
    case 'Enter':
      return mods.alt ? '\x1b\r' : '\r';
    case 'Tab':
      return mods.shift ? '\x1b[Z' : '\t';
    case 'Escape':
      return '\x1b';
    case 'Backspace':
      return mods.ctrl ? '\x08' : mods.alt ? '\x1b\x7f' : '\x7f';
  }
  if (key in CURSOR) return m > 1 ? `\x1b[1;${m}${CURSOR[key]}` : `\x1b${appCursor ? 'O' : '['}${CURSOR[key]}`;
  if (key in TILDE) return m > 1 ? `\x1b[${TILDE[key]};${m}~` : `\x1b[${TILDE[key]}~`;
  if (key in SS3) return m > 1 ? `\x1b[1;${m}${SS3[key]}` : `\x1bO${SS3[key]}`;
  return undefined;
}
