#!/usr/bin/env bash
# Readers and approvers on the admin page (#12, #67), over HTTP against a fresh
# `SMOKE_APP=1 node packages/hub/scripts/smoke-server.mjs`. Exits 1 on any miss.
set -uo pipefail
W=http://127.0.0.1:8797; C=http://127.0.0.1:8798
here="$(cd "$(dirname "$0")/.." && pwd)/.wrangler/smoke"
bodyf=$(mktemp); trap 'rm -f "$bodyf"' EXIT
tok() { jq -r --arg e "$1" '.[$e]' "$here/tokens.json"; }
miss=0
check() { if [ "$2" = "$3" ]; then echo "  ok  $1 -> $2"; else echo "  MISS $1: got '$2' want '$3'"; miss=1; fi; }
has() { if grep -q -- "$2" <<<"$3"; then echo "  ok  $1"; else echo "  MISS $1: no '$2'"; miss=1; fi; }
hasnt() { if grep -q -- "$2" <<<"$3"; then echo "  MISS $1: found '$2'"; miss=1; else echo "  ok  $1"; fi; }
post() { curl -s -o "$bodyf" -w '%{http_code}' -X POST -H "cf-access-jwt-assertion: $(tok "${2:-owner@acme.dev}")" -H "origin: $W" -H 'content-type: application/x-www-form-urlencoded' --data "$1" "$W/_admin/access"; }
page() { curl -s -H "cf-access-jwt-assertion: $(tok owner@acme.dev)" "$W/_admin/"; }
role() { curl -s -H "cf-access-jwt-assertion: $(tok "$1")" "$W/sidecar/_api/me" | jq -r .role; }
body() { cat "$bodyf"; }

echo "== start"; check "pm role" "$(role pm@acme.dev)" approver

echo "== 1: remove an entry only in git -> hidden, row kept"
check "POST add reader zed" "$(post 'site=sidecar&list=readers&action=add&entry=zed@partner.example')" 200
has "page: zed added, deploy pending" 'zed@partner.example</span><span class="meta">added, deploy pending' "$(page)"
check "POST remove reader zed" "$(post 'site=sidecar&list=readers&action=remove&entry=zed@partner.example')" 200
p=$(page); hasnt "page: zed not shown" 'zed@partner.example' "$p"
check "row for zed kept" "$(curl -s $C/pending | jq -r '[.[]|select(.entry=="zed@partner.example")]|length')" 1
check "docs-hub readers in git" "$(curl -s "$C/repo-file?repo=docs-hub&ref=main&path=specreview.config.json" | jq -r 'fromjson|.sites[0].readers|join(",")')" "@initech.example"

echo "== 3: remove a deployed approver -> refused at once, Add back"
check "POST remove approver pm" "$(post 'site=sidecar&list=approvers&action=remove&entry=pm@acme.dev')" 200
check "pm role after removal" "$(role pm@acme.dev)" team
p=$(page); has "page: pm removed, deploy pending" 'pm@acme.dev</span><span class="meta">removed, deploy pending' "$p"
t1=$(curl -s $C/pending | jq -r '.[]|select(.entry=="pm@acme.dev")|.removed_at')

echo "== 9: Let back in from a stale page -> nothing cleared"
check "POST remove pm again (already gone from git)" "$(post 'site=sidecar&list=approvers&action=remove&entry=pm@acme.dev')" 200
t2=$(curl -s $C/pending | jq -r '.[]|select(.entry=="pm@acme.dev")|.removed_at')
if [ "$t2" -gt "$t1" ]; then echo "  ok  repeat removal moved the time forward"; else echo "  MISS time did not move ($t1 -> $t2)"; miss=1; fi
check "POST restore with the old time" "$(post "site=sidecar&list=approvers&action=restore&entry=pm@acme.dev&removed_at=$t1")" 200
has "answer: changed, reload" 'changed since the page was loaded; reload the admin page' "$(body)"
check "pm still refused as approver" "$(role pm@acme.dev)" team

echo "== 10, 11: restore without a time, or by a non-admin"
check "POST restore without removed_at" "$(post 'site=sidecar&list=approvers&action=restore&entry=pm@acme.dev')" 400
has "answer: reload" 'Reload the admin page and try again' "$(body)"
check "POST restore as dev (not admin)" "$(post "site=sidecar&list=approvers&action=restore&entry=pm@acme.dev&removed_at=$t2" dev@acme.dev)" 403

echo "== 8: Let back in with the current time"
check "POST restore with the current time" "$(post "site=sidecar&list=approvers&action=restore&entry=pm@acme.dev&removed_at=$t2")" 200
check "pm approver again" "$(role pm@acme.dev)" approver

echo "== 7: add zed back clears its row"
check "POST add reader zed" "$(post 'site=sidecar&list=readers&action=add&entry=zed@partner.example')" 200
hasnt "answer: no still-refused note" 'refuses them' "$(body)"
check "row for zed gone" "$(curl -s $C/pending | jq -r '[.[]|select(.entry=="zed@partner.example")]|length')" 0

echo "== rows left:"; curl -s $C/pending | jq -c '[.[]|{entry,list}]'
[ $miss = 0 ] && echo "SMOKE PASS" || { echo "SMOKE FAIL"; exit 1; }
