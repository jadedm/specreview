#!/usr/bin/env bash
# Builds test/smoke-docs as the site "sidecar" from a fresh git repo with two
# commits, for the hub's browser smoke. Prints the output folder.
#   pnpm --filter @specreview/site build
#   OUT=$(packages/site/scripts/smoke-fixture.sh)
#   SMOKE_SITE=$OUT node packages/hub/scripts/smoke-server.mjs
set -euo pipefail
site="$(cd "$(dirname "$0")/.." && pwd)"
repo="$(mktemp -d)"
mkdir -p "$repo/docs"
cp -R "$site/test/smoke-docs/." "$repo/docs/"
cd "$repo"
git init -q -b main
git -c user.email=smoke@example.com -c user.name=Smoke add -A
git -c user.email=smoke@example.com -c user.name=Smoke commit -q -m "docs: first (#1)"
printf '\nA later line.\n' >> docs/features.md
git -c user.email=smoke@example.com -c user.name=Smoke commit -q -am "docs: later (#2)"
node "$site/dist/build/cli.js" build --repo sidecar >&2
echo "$repo/.specreview"
