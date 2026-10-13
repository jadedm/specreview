#!/usr/bin/env bash
# Applies this repo's config to the hub: setup --apply, then deploy, saving
# hub.json to main after each. .github/workflows/apply.yml runs it on main
# with the Cloudflare token in CLOUDFLARE_API_TOKEN. run.sh gets the token as
# a mode-600 file deleted on exit, not in its environment; everything run.sh
# runs (the pinned specreview checkout and its pnpm install) is trusted with
# it, as is anyone who can push to this repo.
set -uo pipefail
ORG=$(cd "$(dirname "$0")" && pwd)
cd "$ORG"
BRANCH=main

fail() {
  echo "apply: $1" >&2
  exit 2
}

[ "${GITHUB_REF:-}" = "refs/heads/$BRANCH" ] || fail "runs only on $BRANCH (GITHUB_REF is ${GITHUB_REF:-unset})"
[ -n "${CLOUDFLARE_API_TOKEN:-}" ] || fail "the CLOUDFLARE_API_TOKEN secret is not set"

# Apply the newest main, not the commit that started this run: a run queued
# behind another must see the hub.json ids that run recorded.
git fetch -q origin "$BRANCH" || fail "could not fetch $BRANCH"
git checkout -q -B "$BRANCH" "origin/$BRANCH" || fail "could not check out origin/$BRANCH"

# The Actions bot commits hub.json; a fresh runner has no git identity, and
# a rebase rewrites the commit, so both need it.
export GIT_AUTHOR_NAME='github-actions[bot]' GIT_COMMITTER_NAME='github-actions[bot]'
export GIT_AUTHOR_EMAIL='41898282+github-actions[bot]@users.noreply.github.com'
export GIT_COMMITTER_EMAIL=$GIT_AUTHOR_EMAIL

TOKEN_FILE=$(mktemp)
trap 'rm -f "$TOKEN_FILE"' EXIT
chmod 600 "$TOKEN_FILE"
printf '%s' "$CLOUDFLARE_API_TOKEN" > "$TOKEN_FILE"
unset CLOUDFLARE_API_TOKEN

# Commits hub.json alone if it changed and pushes it, rebasing once onto a
# newer main. setup records each id as it creates the resource, so this runs
# after setup and after deploy whether or not they succeeded.
save() {
  git diff --quiet -- hub.json && return 0
  git commit -q -m "chore(hub): record $1 in hub.json" -- hub.json || return 1
  # This run's hub.json as committed: after a conflicted rebase the file on
  # disk holds conflict markers.
  local mine
  mine=$(git show HEAD:hub.json)
  git push -q origin "HEAD:$BRANCH" && return 0
  git pull -q --rebase --autostash origin "$BRANCH" && git push -q origin "HEAD:$BRANCH" && return 0
  # The ids exist nowhere else once this runner is gone. They are not secret.
  echo "apply: could not push hub.json after $1. It holds ids the next run needs; copy it into the repo by hand:" >&2
  printf '%s\n' "$mine" >&2
  return 1
}

status=0
./run.sh setup --token-file "$TOKEN_FILE" --apply || status=$?
save "setup's resources" || [ "$status" -ne 0 ] || status=1
[ "$status" -eq 0 ] || exit "$status"
./run.sh deploy --token-file "$TOKEN_FILE" || status=$?
save "the deploy" || [ "$status" -ne 0 ] || status=1
exit "$status"
