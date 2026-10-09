/**
 * Reads `wrangler.jsonc` without a dependency: strips comments and trailing
 * commas, leaves strings alone. The scripts in `bin/` read the site list and
 * the account from the same file the Worker is deployed with, so there is one
 * place to change them.
 */
export function parseJsonc(text) {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    const next = text[i + 1];
    if (inString) {
      out += c;
      if (c === '\\') { out += next ?? ''; i += 1; } else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === '/' && next === '/') { while (i < text.length && text[i] !== '\n') i += 1; out += '\n'; continue; }
    if (c === '/' && next === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1; i += 1; continue; }
    out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}
