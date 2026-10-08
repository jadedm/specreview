#!/usr/bin/env bash
# Curls against scripts/smoke-server.mjs. One line per call:
# METHOD path as who -> status | type | cache | csp | body start. Exits 1 on any miss.
set -u
W=http://127.0.0.1:8797; C=http://127.0.0.1:8798; here="$(cd "$(dirname "$0")/.." && pwd)/.wrangler/smoke"
tok() { jq -r --arg e "$1" '.[$e]' "$here/tokens.json"; }
fails=0
hit() { # method path who expect [extra curl args...]
  local m=$1 p=$2 who=$3 want=$4; shift 4
  local auth=(); [ "$who" != "-" ] && auth=(-H "cf-access-jwt-assertion: $(tok "$who")")
  local out; out=$(curl -s -o "$here/body" -D "$here/hdr" -w '%{http_code}' -X "$m" ${auth[@]+"${auth[@]}"} "$@" "$W$p")
  local ct cc cd csp body
  ct=$(grep -i '^content-type:' "$here/hdr" | tr -d '\r' | cut -d' ' -f2-)
  cc=$(grep -i '^cache-control:' "$here/hdr" | tr -d '\r' | cut -d' ' -f2-)
  cd=$(grep -i '^content-disposition:' "$here/hdr" | tr -d '\r' | cut -d' ' -f2-)
  csp=$(grep -i '^content-security-policy:' "$here/hdr" | tr -d '\r' | cut -d' ' -f2-)
  body=$(head -c 70 "$here/body" | tr '\n' ' ')
  local mark=ok; [ "$out" != "$want" ] && { mark=FAIL; fails=$((fails+1)); }
  echo "$mark $m $p as $who -> $out | $ct | $cc${cd:+ | $cd}${csp:+ | csp: $csp} | $body"
}
hit GET /sidecar/ riya@initech.example 200
hit GET /sidecar/onboarding/signup riya@initech.example 200
hit GET /sidecar/onboarding/signup Riya@INITECH.example 200
hit HEAD /sidecar/onboarding/signup riya@initech.example 200 -I
hit GET /sidecar/guide/ riya@initech.example 200
hit GET /sidecar/assets/app.js riya@initech.example 200
hit GET /sidecar/assets/logo.svg riya@initech.example 200
hit GET /sidecar/files/report.bin riya@initech.example 200
hit GET /sidecar/missing riya@initech.example 404
hit GET /sidecar/release-1.2 riya@initech.example 200
hit GET /sidecar/manifest.json dev@acme.dev 404
hit POST /sidecar/onboarding/signup riya@initech.example 405
hit GET /sidecar/onboarding/signup - 401 -H 'if-none-match: *'
hit GET /sidecar/onboarding/signup otherApp 401
hit GET /sidecar/onboarding/signup x@stranger.example 403
hit GET /sidecar/_api/status x@stranger.example 403
hit GET /globex/ riya@initech.example 403
hit GET /globex/ dev@acme.dev 403
hit GET /nosuch/ - 404
hit GET /sidecar - 404
hit GET /sidecar/onboarding%2Fsignup riya@initech.example 404
hit GET /sidecar/a//b riya@initech.example 404
hit GET /sidecar/_api riya@initech.example 404
hit GET /sidecar/_api/me riya@initech.example 200
hit GET "/sidecar/_api/tickets?page=onboarding/signup" riya@initech.example 200
hit GET /sidecar/_history/$(printf 'a%.0s' {1..40})/onboarding/signup.md dev@acme.dev 200
hit GET /sidecar/_history/$(printf 'a%.0s' {1..40})/onboarding/signup.md riya@initech.example 403
hit POST /sidecar/_api/status pm@acme.dev 200 -H 'content-type: application/json' -H "origin: $W" --data '{"page":"onboarding/signup","status":"ready","expectedVersion":0,"hash":"h-signup"}'
echo "labels on #52: $(curl -s $C/labels)"
echo "D1 page_status: $(curl -s $C/rows)"
echo "publish V2: $(curl -s $C/publish-v2)"
hit GET /sidecar/onboarding/signup riya@initech.example 200
echo "(pointer cache 10 s; waiting 11 s)"; sleep 11
hit GET /sidecar/onboarding/signup riya@initech.example 200
curl -s $C/break-pointer >/dev/null; sleep 11
hit GET /sidecar/onboarding/signup riya@initech.example 503
echo "failed calls: $fails"
[ "$fails" -eq 0 ]
