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
# Branches only, file contents fetched as checked out: GitHub would hand over
# a commit that exists only in a fork if asked for it by name, so the pin must
# be on one of specreview's own branches.
git clone -q --filter=blob:none --no-checkout https://github.com/jadedm/specreview.git "$CHECKOUT"
[ -n "$(git -C "$CHECKOUT" branch -r --contains "$COMMIT" 2>/dev/null)" ] ||
  { echo "run.sh: $COMMIT is not on a branch of jadedm/specreview" >&2; exit 2; }
git -C "$CHECKOUT" checkout -q --detach "$COMMIT"
(cd "$CHECKOUT" && pnpm install --frozen-lockfile --silent && pnpm --filter @specreview/shared build >/dev/null && pnpm --filter @specreview/hub build >/dev/null)
node "$CHECKOUT/packages/hub/dist/deploy.mjs" "$@" --org "$ORG"
