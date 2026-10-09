/**
 * THE ONLY FILE THAT TALKS TO CLOUDFLARE'S API.
 *
 * `createSource` returns three functions, and everything else in `lib/` only
 * knows their shape (documented in AGENTS.md). Pass your own object with the
 * same shape to `runCollector` and nothing here runs: that is how the tests
 * work without a token or a network.
 *
 * The token needs, on every zone you archive, Zone > Zone > Read and
 * Zone > Analytics > Read. Nothing else. It cannot write anything.
 */

export const GRAPHQL = 'https://api.cloudflare.com/client/v4/graphql';
export const DEFAULT_GROUP_LIMIT = 10_000;

/**
 * The dimensions kept. Each one multiplies the number of groups, and groups
 * are what the 10,000 cap counts, so a dimension is only here if a question
 * needs it. Probed and refused on a Free zone: `clientRequestReferer`,
 * `clientRefererHost`, `botScore`, `botManagementDecision`. That is why this
 * archive cannot tell you how a bot found a page.
 */
const DIMENSIONS = `clientRequestHTTPHost clientRequestPath userAgent
                    verifiedBotCategory clientCountryName edgeResponseStatus`;

export function createSource({ token, accountId, fetch = globalThis.fetch } = {}) {
  if (!token) throw new Error('createSource: no token. Set the CF_ANALYTICS_TOKEN secret on the Worker.');
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  async function graphql(query, variables) {
    const response = await fetch(GRAPHQL, { method: 'POST', headers, body: JSON.stringify({ query, variables }) });
    const body = await response.json().catch(() => ({}));
    if (body.errors?.length) throw new Error(`GraphQL: ${body.errors[0].message}`);
    if (!body.data) throw new Error(`GraphQL: no data (HTTP ${response.status})`);
    return body.data;
  }

  return {
    /**
     * Every zone the token can see, by name. Filtered by account when one is
     * given, which turns "token from the wrong account" into "zone not
     * visible" instead of a run that quietly archives someone else's zone.
     * Paged, because the API stops at 50 per page.
     */
    async zones() {
      const ids = new Map();
      for (let page = 1; page <= 20; page += 1) {
        const url = new URL('https://api.cloudflare.com/client/v4/zones');
        url.searchParams.set('per_page', '50');
        url.searchParams.set('page', String(page));
        if (accountId) url.searchParams.set('account.id', accountId);
        const response = await fetch(url, { headers });
        const body = await response.json().catch(() => ({}));
        if (!body.success) throw new Error(`zones: ${body.errors?.[0]?.message ?? `HTTP ${response.status}`}`);
        for (const z of body.result ?? []) ids.set(z.name, z.id);
        if (page >= (body.result_info?.total_pages ?? 1)) break;
      }
      return ids;
    },

    /**
     * What this zone's plan allows on the dataset, read from the API rather
     * than from documentation. Cloudflare moved its analytics, AI Crawl
     * Control included, from 24 hours to 30 days on 15 September 2026, and
     * parts of its docs still said 24 hours weeks later. A number written in
     * code would have been wrong the day it changed.
     *
     * Returns `{ notOlderThan, maxDuration, maxPageSize }` in seconds and rows,
     * or `null` when the settings node is not readable. The caller falls back.
     */
    async limits(zoneId) {
      const data = await graphql(
        `query Limits($zone: String!) { viewer { zones(filter: { zoneTag: $zone }) {
          settings { httpRequestsAdaptiveGroups { enabled notOlderThan maxDuration maxPageSize } }
        } } }`,
        { zone: zoneId },
      );
      const s = data.viewer?.zones?.[0]?.settings?.httpRequestsAdaptiveGroups;
      if (!s) return null;
      return { enabled: s.enabled, notOlderThan: s.notOlderThan, maxDuration: s.maxDuration, maxPageSize: s.maxPageSize };
    },

    /**
     * One slice of time, grouped by the dimensions above. `botsOnly` adds
     * `verifiedBotCategory_neq: ""`, which is what keeps the bot query small:
     * on a real site it is scanners spraying random paths, not bots, that push
     * a window towards the cap, and they never pass that filter.
     *
     * `truncated` is a guess, because the API does not say: a result exactly
     * at the limit almost certainly had more.
     */
    async readWindow({ zoneId, since, until, botsOnly, limit = DEFAULT_GROUP_LIMIT }) {
      const extra = botsOnly ? ', verifiedBotCategory_neq: ""' : '';
      const data = await graphql(
        `query Window($zone: String!, $since: Time!, $until: Time!, $limit: Int!) {
          viewer { zones(filter: { zoneTag: $zone }) {
            httpRequestsAdaptiveGroups(
              limit: $limit
              filter: { datetime_geq: $since, datetime_lt: $until${extra} }
              orderBy: [count_DESC]
            ) { count dimensions { ${DIMENSIONS} } }
          } }
        }`,
        { zone: zoneId, since: new Date(since).toISOString(), until: new Date(until).toISOString(), limit },
      );
      const rows = data.viewer?.zones?.[0]?.httpRequestsAdaptiveGroups ?? [];
      return { rows, truncated: rows.length >= limit };
    },
  };
}
