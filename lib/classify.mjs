/**
 * What a request was for, and who made it. Pure functions, no I/O.
 *
 * Both are applied by the collector before a row is stored, so they are the
 * same rule for every site in the archive and `kind` stays comparable across
 * all of them. Anything that depends on one site's URL conventions (locale
 * prefixes, sections) is NOT here: it is derived at read time, so a rule fixed
 * later applies to the whole history. See `lib/report.mjs`.
 */

/** Directory names that only ever hold static files, for the common frameworks. */
export const DEFAULT_ASSET_DIRS = [
  '_astro', '_next', '_nuxt', '_app', 'static', 'assets', 'fonts', 'images', 'img', 'icons', 'media', 'build',
];

/**
 * One word per path:
 *
 *   llms    an llms.txt or llms-full.txt index
 *   twin    a Markdown twin (`/page.md`), the format agents are told to prefer
 *   feed    sitemap, robots.txt, RSS
 *   asset   anything static
 *   page    everything else, which is what you actually care about
 *
 * `llms` and `twin` are checked first on purpose: `/llms.txt` ends in `.txt`
 * and would otherwise be filed as an asset, and that is the one file whose
 * fetches you most want to count.
 */
export function kindOf(path, { assetDirs = DEFAULT_ASSET_DIRS } = {}) {
  const p = String(path ?? '').split('?')[0];
  if (/\/llms(-full)?\.txt$/i.test(p)) return 'llms';
  if (/\.md$/i.test(p)) return 'twin';
  if (/\/(sitemap[^/]*\.xml|robots\.txt|rss\.xml|atom\.xml|feed\.xml|feed)$/i.test(p)) return 'feed';
  if (assetDirs.length > 0) {
    const dirs = assetDirs.map((d) => d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    if (new RegExp(`(^|/)(${dirs})/`, 'i').test(p)) return 'asset';
  }
  if (/\.(css|js|mjs|woff2?|ttf|otf|png|jpe?g|gif|webp|avif|svg|ico|txt|xml|json|map|pdf|mp4|webm)$/i.test(p)) return 'asset';
  return 'page';
}

/**
 * Spelling normalisation for the crawlers people ask about. Order matters only
 * where one name contains another: `Claude-SearchBot` before `ClaudeBot` would
 * not matter here because the regex alternation takes the first match in the
 * string, not in this list.
 */
const KNOWN = new RegExp(`(${[
  'GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-User', 'Claude-SearchBot', 'anthropic-ai',
  'PerplexityBot', 'Perplexity-User', 'Google-Extended', 'GoogleOther', 'Google-CloudVertexBot', 'Applebot-Extended',
  'meta-externalagent', 'meta-externalfetcher', 'FacebookBot', 'Amazonbot', 'CCBot', 'cohere-ai', 'Bytespider',
  'DuckAssistBot', 'MistralAI-User', 'YouBot', 'Timpibot', 'bingbot', 'BingPreview', 'Googlebot', 'SemrushBot',
  'AhrefsBot', 'Applebot', 'DuckDuckBot', 'YandexBot', 'Baiduspider', 'facebookexternalhit', 'LinkedInBot',
  'Slackbot', 'Discordbot', 'TelegramBot', 'Twitterbot', 'WhatsApp', 'Yeti',
].join('|')})`, 'i');

/**
 * A bot's name from its User-Agent. Never ''.
 *
 * The list above normalises spelling. Anything it misses falls through to a
 * token from the User-Agent itself, because the crawler nobody has heard of
 * yet is the interesting one. Before this fallback existed, 35% of verified
 * AI crawler requests on one site landed in an empty bucket; on another, 341
 * requests were labelled `Mozilla` until the `compatible;` and operator URL
 * hints were added.
 *
 * Only ever called on rows Cloudflare verified, so the name is a label for a
 * request whose origin was checked by IP, not a claim taken at face value.
 */
export function botName(userAgent) {
  const ua = String(userAgent ?? '');
  const known = ua.match(KNOWN)?.[1];
  if (known) return canonical(known);
  const selfDeclared = ua.match(/([A-Za-z0-9][A-Za-z0-9._+-]*(?:bot|crawler|spider|agent|fetcher)[A-Za-z0-9._+-]*)/i)?.[1];
  if (selfDeclared) return selfDeclared.slice(0, 40);
  const product = ua.trim().split(/[\s/;()]+/)[0] ?? '';
  if (/^(Mozilla|Opera)$/i.test(product)) {
    const compatible = ua.match(/\(\s*compatible;\s*([A-Za-z0-9][A-Za-z0-9._+-]*)/i)?.[1];
    if (compatible && !/^(Mozilla|Opera)$/i.test(compatible)) return compatible.slice(0, 40);
    const operator = ua.match(/\+?https?:\/\/(?:www\.)?([A-Za-z0-9.-]+)/i)?.[1];
    if (operator) return operator.slice(0, 40);
  }
  return product ? product.slice(0, 40) : 'unknown';
}

/** `gptbot` and `GPTBot` are one bot. The list's spelling wins. */
const CANONICAL = new Map(KNOWN.source.slice(1, -1).split('|').map((n) => [n.toLowerCase(), n]));
function canonical(name) {
  return CANONICAL.get(name.toLowerCase()) ?? name;
}
