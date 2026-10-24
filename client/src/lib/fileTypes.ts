const TS = ['TS', '#4a9eff'];
const JS = ['JS', '#e8d44d'];
const PS = ['PS', '#5391fe'];
const YML = ['YML', '#f07178'];
const IMG = ['IMG', '#c792ea'];

const TYPES: Record<string, string[]> = {
  ts: TS, mts: TS, cts: TS, tsx: ['TSX', '#4a9eff'],
  js: JS, mjs: JS, cjs: JS, jsx: ['JSX', '#e8d44d'],
  json: ['{}', '#cbcb41'], html: ['<>', '#f0784a'], css: ['#', '#a77bf3'], scss: ['#', '#f06292'],
  svelte: ['S', '#ff5722'], vue: ['V', '#42b883'], py: ['PY', '#5ca9e6'], cs: ['C#', '#b07fd9'],
  rs: ['RS', '#dea584'], md: ['MD', '#8b949e'], yaml: YML, yml: YML, toml: ['TML', '#9c4221'],
  ps1: PS, psm1: PS, psd1: PS, sh: ['SH', '#89e051'], bat: ['BAT', '#c1f12e'], cmd: ['CMD', '#c1f12e'],
  sql: ['SQL', '#e38c00'], xml: ['XML', '#f0784a'], txt: ['TXT', '#8b949e'], lock: ['LCK', '#8b949e'],
  png: IMG, jpg: IMG, jpeg: IMG, gif: IMG, webp: IMG, svg: ['SVG', '#ffb13b'], ico: IMG,
};

/** A short colored label standing in for a file-type icon. */
export function fileBadge(name: string): { label: string; color: string } {
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  const [label, color] = TYPES[ext] ?? [ext.slice(0, 3).toUpperCase() || '·', 'var(--muted)'];
  return { label, color };
}
