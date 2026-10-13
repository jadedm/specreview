#!/usr/bin/env bash
# Runs specreview's setup, deploy or secret for this organisation, from a
# checkout of specreview at the commit in specreview.commit.
#   ./run.sh setup  --token-file /tmp/.cf-token [--apply]
#   ./run.sh deploy --token-file /tmp/.cf-token [--dry-run]
#   ./run.sh secret --token-file /tmp/.cf-token --name GITHUB_APP_PRIVATE_KEY --value-file /tmp/.gh-app.pem
set -euo pipefail
ORG=$(cd "$(dirname "$0")" && pwd)
COMMIT=$(tr -d '[:space:]' < "$ORG/specreview.commit")
[[ "$COMMIT" =~ ^[0-9a-f]{40}$ && ! "$COMMIT" =~ ^0+$ ]] ||
  { echo "run.sh: set specreview.commit to a full commit of jadedm/specreview" >&2; exit 2; }
CHECKOUT="$ORG/.specreview"
[ -d "$CHECKOUT/.git" ] || git clone -q https://github.com/jadedm/specreview.git "$CHECKOUT"
git -C "$CHECKOUT" fetch -q origin
git -C "$CHECKOUT" checkout -q --detach "$COMMIT"
(cd "$CHECKOUT" && pnpm install --frozen-lockfile --silent && pnpm --filter @specreview/shared build >/dev/null && pnpm --filter @specreview/hub build >/dev/null)
exec node "$CHECKOUT/packages/hub/dist/deploy.mjs" "$@" --org "$ORG"
