import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import type { Extension } from '@codemirror/state';

// language-data covers JS/TS/JSX/TSX, JSON, HTML, CSS, Python, C#, Rust, Markdown, YAML, PowerShell and more.
const svelte = LanguageDescription.of({
  name: 'Svelte',
  extensions: ['svelte'],
  load: () => import('@replit/codemirror-lang-svelte').then((m) => m.svelte()),
});

/** Syntax highlighting for a file name, loaded on demand (each language is its own chunk). */
export async function loadLanguage(filename: string): Promise<Extension> {
  const match = LanguageDescription.matchFilename([svelte, ...languages], filename);
  return match ? match.load().catch(() => []) : [];
}
