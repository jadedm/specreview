#!/usr/bin/env bash
# The admin page on its own hostname (#75), over HTTP against a running
# `node packages/hub/scripts/smoke-server.mjs`. Exits 1 on any miss.
set -uo pipefail
D=http://127.0.0.1:8797; A=http://admin.localhost:8797
here="$(cd "$(dirname "$0")/.." && pwd)/.wrangler/smoke"
tok() { jq -r --arg e "$1" '.[$e]' "$here/tokens.json"; }
# Every token used below must exist: a missing one would turn the 401 checks
# into passes for the wrong reason.
for e in owner@acme.dev dev@acme.dev admin:owner@acme.dev admin:dev@acme.dev; do
  jq -e --arg e "$e" 'has($e)' "$here/tokens.json" > /dev/null || { echo "no smoke token for $e; is the smoke server current?"; exit 1; }
done
miss=0
check() { if [ "$2" = "$3" ]; then echo "  ok  $1 -> $2"; else echo "  MISS $1: got '$2' want '$3'"; miss=1; fi; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
where() { curl -s -o /dev/null -w '%{http_code} %{redirect_url}' "$@"; }

echo "== admin hostname"
check "1 GET /_admin/ as admin" "$(code -H "cf-access-jwt-assertion: $(tok admin:owner@acme.dev)" "$A/_admin/")" 200
# #133: the Sites and GitHub App tabs.
for p in /_admin/sites /_admin/github; do check "1 GET $p as admin" "$(code -H "cf-access-jwt-assertion: $(tok admin:owner@acme.dev)" "$A$p")" 200; done
check "2 docs sign-in on the admin host" "$(code -H "cf-access-jwt-assertion: $(tok owner@acme.dev)" "$A/_admin/")" 401
check "2 admin sign-in on the docs host" "$(code -H "cf-access-jwt-assertion: $(tok admin:dev@acme.dev)" "$D/sidecar/_api/me")" 401
check "3 GET /_admin/ as a non-admin" "$(code -H "cf-access-jwt-assertion: $(tok admin:dev@acme.dev)" "$A/_admin/")" 403
check "4 GET / goes to the admin page" "$(where "$A/")" "302 $A/_admin/"
for p in /sidecar/ /sidecar/_api/me /_publish/sidecar /_admin/nope; do check "4 GET $p is not here" "$(code "$A$p")" 404; done
check "8 post with the docs origin" "$(code -X POST -H "cf-access-jwt-assertion: $(tok admin:owner@acme.dev)" -H "origin: $D" "$A/_admin/github/forget")" 403

echo "== docs hostname"
check "5 GET /_admin/ redirects" "$(where "$D/_admin/")" "308 https://admin.localhost/_admin/"
check "5 GET /_admin/sites redirects" "$(where "$D/_admin/sites?repo=x")" "308 https://admin.localhost/_admin/sites?repo=x"
check "5 GET with a query keeps it" "$(where "$D/_admin/github/created?code=a&state=b")" "308 https://admin.localhost/_admin/github/created?code=a&state=b"
for p in /_admin/access /_admin/sites /_admin/github/forget; do
  check "6 POST $p is not here" "$(code -X POST -H "cf-access-jwt-assertion: $(tok owner@acme.dev)" -H "origin: $D" "$D$p")" 404
done
check "the docs sites still answer" "$(code -H "cf-access-jwt-assertion: $(tok dev@acme.dev)" "$D/sidecar/_api/me")" 200

[ $miss = 0 ] && echo "SMOKE PASS" || { echo "SMOKE FAIL"; exit 1; }
