/** Colors for SGR 30-37 / 90-97 (and backgrounds), the same as the terminal's theme. */
const PALETTE = [
  '#484f58', '#ff7b72', '#3fb950', '#d29922', '#58a6ff', '#bc8cff', '#39c5cf', '#b1bac4',
  '#6e7681', '#ffa198', '#56d364', '#e3b341', '#79c0ff', '#d2a8ff', '#56d4dd', '#f0f6fc',
];

export interface Segment {
  text: string;
  /** Inline CSS for the segment ('' for plain text). */
  style: string;
}

// CSI sequences, OSC strings (ended by BEL or ESC \) and other two-character escapes.
const ESCAPE = /\x1b(?:\[([0-9;:?]*)([@-~])|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[@-Z\\-_])/g;

export const stripAnsi = (text: string) => text.replace(ESCAPE, '');

/** Splits a line of program output into styled segments; colors and bold/dim/italic/underline are kept. */
export function parseAnsi(text: string): Segment[] {
  const segments: Segment[] = [];
  let fg = '';
  let bg = '';
  let bold = false;
  let dim = false;
  let italic = false;
  let underline = false;
  let last = 0;
  const style = () =>
    [fg && `color:${fg}`, bg && `background:${bg}`, bold && 'font-weight:bold', dim && 'opacity:.6', italic && 'font-style:italic', underline && 'text-decoration:underline']
      .filter(Boolean)
      .join(';');
  const push = (end: number) => {
    if (end > last) segments.push({ text: text.slice(last, end), style: style() });
  };
  for (const match of text.matchAll(ESCAPE)) {
    push(match.index);
    last = match.index + match[0].length;
    if (match[2] !== 'm') continue; // only colors matter in a log
    const codes = (match[1] || '0').split(/[;:]/).map(Number);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) [fg, bg, bold, dim, italic, underline] = ['', '', false, false, false, false];
      else if (c === 1) bold = true;
      else if (c === 2) dim = true;
      else if (c === 3) italic = true;
      else if (c === 4) underline = true;
      else if (c === 22) bold = dim = false;
      else if (c === 23) italic = false;
      else if (c === 24) underline = false;
      else if (c >= 30 && c <= 37) fg = PALETTE[c - 30];
      else if (c >= 90 && c <= 97) fg = PALETTE[c - 82];
      else if (c >= 40 && c <= 47) bg = PALETTE[c - 40];
      else if (c >= 100 && c <= 107) bg = PALETTE[c - 92];
      else if (c === 39) fg = '';
      else if (c === 49) bg = '';
      else if (c === 38 || c === 48) {
        const color = codes[i + 1] === 5 ? color256(codes[i + 2]) : codes[i + 1] === 2 ? `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})` : '';
        i += codes[i + 1] === 5 ? 2 : codes[i + 1] === 2 ? 4 : 0;
        if (c === 38) fg = color;
        else bg = color;
      }
    }
  }
  push(text.length);
  return segments;
}

function color256(n: number): string {
  if (!(n >= 0 && n <= 255)) return '';
  if (n < 16) return PALETTE[n];
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `rgb(${v},${v},${v})`;
  }
  const i = n - 16;
  const level = (x: number) => (x ? 55 + x * 40 : 0);
  return `rgb(${level(Math.floor(i / 36))},${level(Math.floor(i / 6) % 6)},${level(i % 6)})`;
}
