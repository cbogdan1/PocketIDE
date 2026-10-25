/** A "file:line" reference in compiler or runtime output; start/end are offsets in the (color-free) text. */
export interface FileRef {
  start: number;
  end: number;
  path: string;
  line: number;
  col?: number;
}

const PATH = String.raw`(?:[A-Za-z]:)?[\w.$@~+\-\\/]*\.[A-Za-z][A-Za-z0-9]{0,9}`;
const PATTERNS = [
  // Python tracebacks: File "C:\app\main.py", line 3
  new RegExp(String.raw`File "([^"]+)", line (\d+)`, 'g'),
  // MSBuild/dotnet and tsc: Program.cs(10,5): error ...
  new RegExp(String.raw`(?<![\w/\\.:])(${PATH})\((\d+)(?:,(\d+))?\)`, 'g'),
  // gcc, clang, rustc/cargo (--> src/main.rs:2:5), tsc --pretty, Node stack traces (also file:///C:/...)
  new RegExp(String.raw`(?<![\w/\\.:])(?:file:\/\/\/)?(${PATH}):(\d+)(?::(\d+))?`, 'g'),
];

/** Every file reference in a line of output, in order, without overlaps. */
export function findFileRefs(text: string): FileRef[] {
  const refs: FileRef[] = [];
  for (const re of PATTERNS) {
    for (const m of text.matchAll(re)) {
      const start = m.index;
      const end = start + m[0].length;
      if (refs.some((r) => start < r.end && end > r.start)) continue;
      const line = Number(m[2]);
      if (line < 1) continue;
      refs.push({ start, end, path: m[1], line, col: m[3] ? Number(m[3]) : undefined });
    }
  }
  return refs.sort((a, b) => a.start - b.start);
}

/**
 * The projects-root-relative path for a reference made by a program running in `cwd` (root-relative): relative
 * paths are taken from there, absolute ones must lie inside the projects folder. null if it can't be opened.
 */
export function resolveRef(path: string, cwd: string, projectsRoot: string): string | null {
  const p = path.replaceAll('\\', '/');
  let parts: string[];
  if (/^[A-Za-z]:\//.test(p) || p.startsWith('/')) {
    const root = projectsRoot.replaceAll('\\', '/').replace(/\/$/, '') + '/';
    if (!p.toLowerCase().startsWith(root.toLowerCase())) return null;
    parts = p.slice(root.length).split('/');
  } else parts = [...cwd.split('/'), ...p.split('/')];
  const out: string[] = [];
  for (const part of parts) {
    if (part === '..') {
      if (!out.pop()) return null;
    } else if (part && part !== '.') out.push(part);
  }
  return out.length > 1 ? out.join('/') : null; // a file inside a project, not the projects folder itself
}
