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
hit GET /sidecar/ riya@ariai.example 200
hit GET /sidecar/onboarding/signup riya@ariai.example 200
hit GET /sidecar/onboarding/signup Riya@ARIAI.example 200
hit HEAD /sidecar/onboarding/signup riya@ariai.example 200 -I
hit GET /sidecar/guide/ riya@ariai.example 200
hit GET /sidecar/assets/app.js riya@ariai.example 200
hit GET /sidecar/assets/logo.svg riya@ariai.example 200
hit GET /sidecar/files/report.bin riya@ariai.example 200
hit GET /sidecar/missing riya@ariai.example 404
hit GET /sidecar/release-1.2 riya@ariai.example 200
hit GET /sidecar/manifest.json dev@inoltro.ai 404
hit POST /sidecar/onboarding/signup riya@ariai.example 405
hit GET /sidecar/onboarding/signup - 401 -H 'if-none-match: *'
hit GET /sidecar/onboarding/signup otherApp 401
hit GET /sidecar/onboarding/signup x@stranger.example 403
hit GET /sidecar/_api/status x@stranger.example 403
hit GET /tikiti/ riya@ariai.example 403
hit GET /tikiti/ dev@inoltro.ai 403
hit GET /nosuch/ - 404
hit GET /sidecar - 404
hit GET /sidecar/onboarding%2Fsignup riya@ariai.example 404
hit GET /sidecar/a//b riya@ariai.example 404
hit GET /sidecar/_api riya@ariai.example 404
hit GET /sidecar/_api/me riya@ariai.example 200
hit GET "/sidecar/_api/tickets?page=onboarding/signup" riya@ariai.example 200
hit GET /sidecar/_api/pages riya@ariai.example 200
hit GET /sidecar/_api/pages dev@inoltro.ai 200
hit GET /sidecar/_history/$(printf 'a%.0s' {1..40})/onboarding/signup.md dev@inoltro.ai 200
hit GET /sidecar/_history/$(printf 'a%.0s' {1..40})/onboarding/signup.md riya@ariai.example 403
hit POST /sidecar/_api/status pm@inoltro.ai 200 -H 'content-type: application/json' -H "origin: $W" --data '{"page":"onboarding/signup","status":"ready","expectedVersion":0,"hash":"h-signup"}'
echo "labels on #52: $(curl -s $C/labels)"
# A team member comments, so the reader's comment list has someone else in it.
hit POST /sidecar/_api/comments dev@inoltro.ai 201 -H 'content-type: application/json' -H "origin: $W" --data '{"page":"onboarding/signup","heading":"who","quote":"Any signed-in admin","body":"Is this still true?"}'
# A reader's view: labels, no emails, no ticket titles. Each call must answer
# 200 with a body, or the leak check below would pass on an error.
readers_paths=(/sidecar/_api/status "/sidecar/_api/tickets?page=onboarding/signup" /sidecar/_api/pages "/sidecar/_api/comments?page=onboarding/signup")
for p in "${readers_paths[@]}"; do
  code=$(curl -s -o "$here/body" -w '%{http_code}' -H "cf-access-jwt-assertion: $(tok riya@ariai.example)" "$W$p")
  body=$(cat "$here/body")
  if [ "$code" != 200 ] || [ "${#body}" -lt 3 ]; then echo "FAIL reader view of $p answered $code"; fails=$((fails+1)); fi
  for leak in pm@inoltro.ai dev@inoltro.ai "Company approval" '"history"'; do
    if grep -qF "$leak" <<<"$body"; then echo "FAIL reader view of $p carries $leak"; fails=$((fails+1)); fi
  done
done
# Control: the team's view does carry them, so the check above can fire.
team_view=$(for p in "${readers_paths[@]}"; do curl -s -H "cf-access-jwt-assertion: $(tok dev@inoltro.ai)" "$W$p"; done)
# (pm's change was superseded by dev's comment, which moved the page back to in review.)
for want in dev@inoltro.ai "Company approval" '"history"'; do
  if ! grep -qF "$want" <<<"$team_view"; then echo "FAIL team view lacks $want, so the reader check proves nothing"; fails=$((fails+1)); fi
done
echo "reader status changedBy: $(curl -s -H "cf-access-jwt-assertion: $(tok riya@ariai.example)" "$W/sidecar/_api/status" | jq -c '[.[] | .changedBy]')"
echo "D1 page_status: $(curl -s $C/rows)"
echo "publish V2: $(curl -s $C/publish-v2)"
hit GET /sidecar/onboarding/signup riya@ariai.example 200
echo "(pointer cache 10 s; waiting 11 s)"; sleep 11
hit GET /sidecar/onboarding/signup riya@ariai.example 200
curl -s $C/break-pointer >/dev/null; sleep 11
hit GET /sidecar/onboarding/signup riya@ariai.example 503
echo "failed calls: $fails"
[ "$fails" -eq 0 ]
