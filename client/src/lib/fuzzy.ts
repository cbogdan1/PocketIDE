/** How well `query` matches `text` as an in-order subsequence (higher is better), or -1 if it doesn't. */
function score(query: string, text: string): number {
  let total = 0;
  let from = 0;
  let prev = -2;
  for (const ch of query) {
    const at = text.indexOf(ch, from);
    if (at < 0) return -1;
    total += 1;
    if (at === prev + 1) total += 4; // consecutive letters
    if (at === 0 || '/\\._- '.includes(text[at - 1])) total += 3; // start of a word
    prev = at;
    from = at + 1;
  }
  return total;
}

/** Fuzzy-scores a file path, strongly preferring matches inside the file name. */
export function fuzzyScore(query: string, path: string): number {
  const q = query.toLowerCase().replace(/\s+/g, '');
  const p = path.toLowerCase();
  if (!q) return 0;
  const name = score(q, p.slice(p.lastIndexOf('/') + 1));
  const best = name >= 0 ? name + 100 : score(q, p);
  return best < 0 ? -1 : best - p.length / 1000; // shorter paths break ties
}

/** The best `limit` matches for `query`, best first. */
export function fuzzyFilter(query: string, paths: string[], limit = 50): string[] {
  return paths
    .map((path) => ({ path, score: fuzzyScore(query, path) }))
    .filter((m) => m.score >= 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((m) => m.path);
}
