export interface DiskText {
  /** Without the BOM; line endings as on disk (CodeMirror splits on any of them). */
  text: string;
  bom: boolean;
  eol: '\n' | '\r\n';
}

/** Splits off what CodeMirror would lose: a UTF-8 BOM, and CRLF line endings (it joins lines with \n). */
export function fromDisk(raw: string): DiskText {
  const bom = raw.startsWith('﻿');
  const text = bom ? raw.slice(1) : raw;
  return { text, bom, eol: text.includes('\r\n') ? '\r\n' : '\n' };
}

/** The inverse of fromDisk for an editor document (which always uses \n). */
export function toDisk(doc: string, bom: boolean, eol: string): string {
  return (bom ? '﻿' : '') + (eol === '\n' ? doc : doc.replaceAll('\n', eol));
}

/** The indent a file already uses: a tab, or the smallest even run of leading spaces (2 if unsure). */
export function detectIndent(text: string): string {
  let tabs = 0;
  let spaces = 0;
  let unit = 0;
  for (const [, lead] of text.slice(0, 100_000).matchAll(/^([ \t]+)\S/gm)) {
    if (lead[0] === '\t') tabs++;
    else {
      spaces++;
      // Odd widths are usually alignment, like the " *" lines of a doc comment.
      if (lead.length % 2 === 0 && (!unit || lead.length < unit)) unit = lead.length;
    }
  }
  return tabs > spaces ? '\t' : ' '.repeat(Math.min(unit || 2, 8));
}
