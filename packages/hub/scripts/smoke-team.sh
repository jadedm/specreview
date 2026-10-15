#!/usr/bin/env bash
# #91 against the running smoke server (`node packages/hub/scripts/smoke-server.mjs`):
# a team member named by email and an approver outside the team domain.
# Exits 1 on any miss.
set -u
W=http://127.0.0.1:8797
here="$(cd "$(dirname "$0")/.." && pwd)/.wrangler/smoke"
tok() { jq -r --arg e "$1" '.[$e]' "$here/tokens.json"; }
miss=0
check() { # label expected actual
  if [ "$2" = "$3" ]; then echo "  ok  $1 -> $3"; else echo "  MISS $1: expected $2, got $3 ($(head -c 200 /tmp/claude-smoke-team.json))"; miss=1; fi
}
api() { # email method path [json]
  local body=()
  [ -n "${4:-}" ] && body=(-H 'content-type: application/json' --data "$4")
  curl -s -o /tmp/claude-smoke-team.json -w '%{http_code}' -X "$2" "$W/sidecar/_api/$3" \
    -H "cf-access-jwt-assertion: $(tok "$1")" -H "origin: $W" ${body[@]+"${body[@]}"}
}
role() { api "$1" GET me >/dev/null; jq -r '.role // empty' /tmp/claude-smoke-team.json; }

check "team member's role" team "$(role lead@contractor.example)"
check "outside approver's role" approver "$(role boss@elsewhere.example)"
check "reader's role" reader "$(role riya@initech.example)"
check "a stranger" 403 "$(api x@stranger.example GET me)"

# The reader comments; the team member sees the reader's email, the reader sees the team label for the team member.
code=$(api riya@initech.example POST comments '{"page":"onboarding/signup","heading":"who","quote":"Any signed-in admin","body":"From a reader"}')
check "reader comments" 201 "$code"
id=$(jq -r '.id' /tmp/claude-smoke-team.json)
api lead@contractor.example POST comments '{"page":"onboarding/signup","heading":"who","quote":"Any signed-in admin","body":"From the team member"}' >/dev/null
lead=$(jq -r '.id' /tmp/claude-smoke-team.json)
api lead@contractor.example GET "comments?page=onboarding%2Fsignup" >/dev/null
check "team member sees the reader's email" true "$(jq '[.[].author] | index("riya@initech.example") != null' /tmp/claude-smoke-team.json)"
api riya@initech.example GET "comments?page=onboarding%2Fsignup" >/dev/null
check "reader sees the team label" true "$(jq '[.[].author] | index("acme team") != null' /tmp/claude-smoke-team.json)"

# The outside approver resolves the reader's thread and signs the page off.
check "outside approver resolves" 200 "$(api boss@elsewhere.example POST "comments/$id/resolve" '{}')"
check "outside approver resolves the team member's" 200 "$(api boss@elsewhere.example POST "comments/$lead/resolve" '{}')"
api riya@initech.example GET status >/dev/null
v=$(jq -r '[.[] | select(.page=="onboarding/signup")][0].version // 0' /tmp/claude-smoke-team.json)
# Built with printf: a {...,...} inside a nested "$(...)" is brace-expanded by bash.
status_body() { printf '{"page":"onboarding/signup","status":"%s","expectedVersion":%s,"hash":"h-signup"}' "$1" "$2"; }
check "outside approver: in review" 200 "$(api boss@elsewhere.example POST status "$(status_body in_review "$v")")"
check "team member may not sign off" 403 "$(api lead@contractor.example POST status "$(status_body ready "$((v + 1))")")"
check "outside approver: ready" 200 "$(api boss@elsewhere.example POST status "$(status_body ready "$((v + 1))")")"

rm -f /tmp/claude-smoke-team.json
[ "$miss" -eq 0 ] && echo "SMOKE PASS" || { echo "SMOKE FAIL"; exit 1; }
