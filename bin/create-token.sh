#!/usr/bin/env bash
# Creates the read-only CF_ANALYTICS_TOKEN, tests it, and sets it as the
# Worker secret, without the value ever being printed, written to disk, or
# passed through anything but a shell variable. Run it yourself:
#
#   bash bin/create-token.sh
#
# Needs the `cf` CLI (`npm i -g cf`, then `cf auth login`) logged in
# to the account that owns the zones, and python3 for JSON.
#
# Re-run it after adding a site to SITES: it creates a fresh token covering
# every listed zone and replaces the secret. Then delete the previous token in
# the dashboard (My Profile > API Tokens).
#
# Permissions, all read-only, each zone listed explicitly: Zone > Zone > Read
# and Zone > Analytics > Read. A policy on "all zones from an account" looks
# equivalent and is not: on some token screens the Analytics permission is not
# even offered under that scope, and the result is a token that can list a
# zone and read none of its analytics.
#
# The two ids below are Cloudflare's permission groups, the same on every
# account (`cf user tokens permission-groups list` to check).
set -euo pipefail
cd "$(dirname "$0")/.."

ZONE_READ=c8fed203ed3043cba015a93ad1616f1f
ANALYTICS_READ=9c88f9c5bce24ce7af9a958ba9c504db

SITES=$(node -e 'import("./lib/jsonc.mjs").then(({ parseJsonc }) => {
  const c = parseJsonc(require("fs").readFileSync("wrangler.jsonc", "utf8"));
  console.log((c.vars.SITES || []).map((s) => s.zone).join(","));
})')
POLICIES=$(mktemp)
trap 'rm -f "$POLICIES"' EXIT

cf zones list 2>/dev/null | SITES="$SITES" ZONE_READ="$ZONE_READ" ANALYTICS_READ="$ANALYTICS_READ" python3 -c '
import json, os, sys
zones = {z["name"]: z["id"] for z in json.load(sys.stdin)}
wanted = [s for s in os.environ["SITES"].split(",") if s]
missing = [s for s in wanted if s not in zones]
if not wanted: sys.exit("SITES is empty in wrangler.jsonc")
if missing: sys.exit(f"not on this account: {missing}")
print(json.dumps([{
  "effect": "allow",
  "permission_groups": [{"id": os.environ["ZONE_READ"]}, {"id": os.environ["ANALYTICS_READ"]}],
  "resources": {f"com.cloudflare.api.account.zone.{zones[s]}": "*" for s in wanted},
}]))' > "$POLICIES"

echo "Creating a read-only token for: $SITES"
# From cf's JSON straight into a variable. Never echoed.
TOKEN=$(cf user tokens create --name "ai-crawl-history $(date -u +%Y-%m-%d)" --policies "@$POLICIES" 2>/dev/null \
  | python3 -c 'import json, sys; d = json.load(sys.stdin); d = d.get("result", d); print(d["value"])')

echo "Testing it (a new token can take a few seconds to become active)..."
sleep 5
CF_ANALYTICS_TOKEN="$TOKEN" node bin/preflight.mjs

echo "Setting the Worker secret..."
printf '%s' "$TOKEN" | npx wrangler secret put CF_ANALYTICS_TOKEN >/dev/null
unset TOKEN
echo "Done. The next run (every 4 hours, at :07 UTC) will use it."
