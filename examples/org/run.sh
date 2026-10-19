#!/usr/bin/env bash
# Runs specreview's setup, deploy, secret or workflow-token for this
# organisation, from a checkout of specreview at the commit in specreview.commit.
#   ./run.sh setup  --token-file /tmp/.cf-token [--apply]
#   ./run.sh deploy --token-file /tmp/.cf-token [--dry-run]
#   ./run.sh secret --token-file /tmp/.cf-token --name GITHUB_APP_PRIVATE_KEY --value-file /tmp/.gh-app.pem
#   ./run.sh workflow-token --token-file /tmp/.cf-token --out /tmp/.cf-workflow-token
#   ./run.sh check-docs ../product --repo product [--docs docs] [--exclude <path>]... [--prototypes <path>]...
set -euo pipefail
# A CDPATH would make cd print the folder, doubling the paths taken from it.
unset CDPATH
ORG=$(cd "$(dirname "$0")" && pwd)
# Set here only, never taken from the environment: OUT is deleted on exit.
PRODUCT=""
OUT=""
# check-docs (#92) builds a product repo's docs as its publish workflow would,
# into a folder of its own in that repo, deleted after; it needs no token.
if [ "${1:-}" = check-docs ]; then
  [ -n "${2:-}" ] && [ -d "$2" ] ||
    { echo "usage: ./run.sh check-docs <product repo> --repo <name> [--docs docs] [--exclude <path>]... [--prototypes <path>]..." >&2; exit 2; }
  PRODUCT=$(cd "$2" && pwd)
  OUT="$PRODUCT/.specreview-check"
  [ ! -e "$OUT" ] && [ ! -L "$OUT" ] || { echo "run.sh: $OUT already exists; move it away first" >&2; exit 2; }
  shift 2
fi
COMMIT=$(tr -d '[:space:]' < "$ORG/specreview.commit")
[[ "$COMMIT" =~ ^[0-9a-f]{40}$ && ! "$COMMIT" =~ ^0+$ ]] ||
  { echo "run.sh: set specreview.commit to a full commit of jadedm/specreview" >&2; exit 2; }
# A fresh clone of the pinned commit for every run, deleted after: what is
# built and run here gets the Cloudflare token, so nothing is reused from an
# earlier run (a kept checkout's ignored files and git settings can run code).
CHECKOUT=$(mktemp -d)
trap 'rm -rf "$CHECKOUT" ${OUT:+"$OUT"}' EXIT
# Branches only, file contents fetched as checked out: GitHub would hand over
# a commit that exists only in a fork if asked for it by name, so the pin must
# be on one of specreview's own branches.
git clone -q --filter=blob:none --no-checkout https://github.com/jadedm/specreview.git "$CHECKOUT"
[ -n "$(git -C "$CHECKOUT" branch -r --contains "$COMMIT" 2>/dev/null)" ] ||
  { echo "run.sh: $COMMIT is not on a branch of jadedm/specreview" >&2; exit 2; }
git -C "$CHECKOUT" checkout -q --detach "$COMMIT"
if [ -n "${PRODUCT:-}" ]; then
  (cd "$CHECKOUT" && pnpm install --frozen-lockfile --silent && pnpm --filter @specreview/shared build >/dev/null && pnpm --filter @specreview/site build >/dev/null)
  (cd "$PRODUCT" && node "$CHECKOUT/packages/site/dist/build/cli.js" build "$@" --out "$OUT")
  echo "check-docs: the docs build; nothing was published"
  exit 0
fi
(cd "$CHECKOUT" && pnpm install --frozen-lockfile --silent && pnpm --filter @specreview/shared build >/dev/null && pnpm --filter @specreview/hub build >/dev/null)
node "$CHECKOUT/packages/hub/dist/deploy.mjs" "$@" --org "$ORG"
