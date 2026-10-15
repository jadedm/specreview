#!/usr/bin/env bash
# Runs specreview's setup, deploy, secret or workflow-token for this
# organisation, from a checkout of specreview at the commit in specreview.commit.
#   ./run.sh setup  --token-file /tmp/.cf-token [--apply]
#   ./run.sh deploy --token-file /tmp/.cf-token [--dry-run]
#   ./run.sh secret --token-file /tmp/.cf-token --name GITHUB_APP_PRIVATE_KEY --value-file /tmp/.gh-app.pem
#   ./run.sh workflow-token --token-file /tmp/.cf-token --out /tmp/.cf-workflow-token
set -euo pipefail
ORG=$(cd "$(dirname "$0")" && pwd)
COMMIT=$(tr -d '[:space:]' < "$ORG/specreview.commit")
[[ "$COMMIT" =~ ^[0-9a-f]{40}$ && ! "$COMMIT" =~ ^0+$ ]] ||
  { echo "run.sh: set specreview.commit to a full commit of jadedm/specreview" >&2; exit 2; }
# A fresh clone of the pinned commit for every run, deleted after: what is
# built and run here gets the Cloudflare token, so nothing is reused from an
# earlier run (a kept checkout's ignored files and git settings can run code).
CHECKOUT=$(mktemp -d)
trap 'rm -rf "$CHECKOUT"' EXIT
git -C "$CHECKOUT" init -q
git -C "$CHECKOUT" remote add origin https://github.com/jadedm/specreview.git
git -C "$CHECKOUT" fetch -q --depth 1 origin "$COMMIT"
git -C "$CHECKOUT" checkout -q --detach FETCH_HEAD
[ "$(git -C "$CHECKOUT" rev-parse HEAD)" = "$COMMIT" ] ||
  { echo "run.sh: GitHub did not give commit $COMMIT" >&2; exit 2; }
(cd "$CHECKOUT" && pnpm install --frozen-lockfile --silent && pnpm --filter @specreview/shared build >/dev/null && pnpm --filter @specreview/hub build >/dev/null)
node "$CHECKOUT/packages/hub/dist/deploy.mjs" "$@" --org "$ORG"
