# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# specreview

Review specs where they are rendered. Teams keep Markdown in each repo's `docs/`; specreview publishes it to one site the team hosts on its own Cloudflare account, where readers comment on selected text and product signs pages off; the sign-off shows on linked GitHub issues as a label. Open source (MIT), self-hosted only. Plan and domain model: issue #1. Grown from inoltrotech/sidecar's docs site (sidecar #55, PR #56).

Run through `~/.claude/doctrine/dev-loop.md`. This file lists only what is specific to this repo.

## Branches

Gitflow. `develop` is the integration branch and the GitHub default; `main` takes releases only. Branches are `<prefix>/<issue>-<slug>` from `develop`; always pass `--base develop` to `gh pr create`. Husky blocks direct pushes to `develop` and `main`, bad branch names, non-conventional commits and env files; hooks are bypassable, so this is a convention.

Solo repo for now: loop step 12 (team review) is N/A.

## Layout

pnpm workspace, one package per part:

| Package           | What it is                                                                         | Ticket     |
| ----------------- | ---------------------------------------------------------------------------------- | ---------- |
| `packages/hub`    | The Cloudflare Worker a team deploys: API, comments, status, labels, serving sites | #3, #4, #6 |
| `packages/site`   | The VitePress theme and build every site uses                                      | #4, #5     |
| `packages/action` | The publish GitHub Action                                                          | #5         |
| `packages/cli`    | `@jadedm/specreview`: init, add a site, create the GitHub App                      | #7         |

## Commands

```
pnpm install --frozen-lockfile
pnpm lint            # autofix
pnpm lint:check      # assert clean; CI uses this, never lint
pnpm format:check
pnpm typecheck       # tsc in every package, separate from any bundler
pnpm test            # vitest in every package; the hub runs in workerd
pnpm build
pnpm --filter @specreview/hub test   # one package
```

Library packages build with `tsconfig.build.json`, which leaves tests out of `dist/`; Vitest looks only in `src/` (the hub also in `test/`).
