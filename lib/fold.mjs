/**
 * Sums rows that collapse to the same key.
 *
 * The key is every stored field except the count, derived fields included. Get
 * this wrong and the archive lies quietly: folding on the raw User-Agent while
 * storing a normalised bot name writes two lines for one bot, and every
 * `COUNT(*)` downstream is inflated.
 *
 * Fields are joined with NUL, because a URL path can legally contain a space,
 * a tab or a pipe. Written as the `\u0000` escape and never as a literal NUL
 * byte: a literal one makes git and grep treat the source file as binary,
 * which happened twice before this comment existed.
 */
export function fold(rows, count = 'requests') {
  const out = new Map();
  for (const row of rows) {
    const key = Object.keys(row).filter((f) => f !== count).sort().map((f) => String(row[f])).join('\u0000');
    const seen = out.get(key);
    if (seen) seen[count] += row[count];
    else out.set(key, { ...row });
  }
  return [...out.values()];
}
