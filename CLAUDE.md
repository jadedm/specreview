# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# specreview

Review specs where they are rendered. Teams keep Markdown in each repo's `docs/`; specreview publishes it to one site the team hosts on its own Cloudflare account, where readers comment on selected text and product signs pages off; the sign-off shows on linked GitHub issues as a label. Open source (MIT), self-hosted only. Plan and domain model: issue #1.

Every change: an issue first, then a test plan on the issue before code, a branch, a PR, the full local gate before each push, and review before merge.

## Branches

Gitflow. `develop` is the integration branch and the GitHub default; `main` takes releases only. Branches are `<prefix>/<issue>-<slug>` (prefix one of feature, bugfix, hotfix, chore, fix, ci, infra, refactor, docs) or `release/<x.y.z>`, cut from `develop`; always pass `--base develop` to `gh pr create`. Husky refuses env files at commit, non-conventional commit messages, and pushes to `develop`, `main` or a badly named branch (tags pass). Hooks are installed by `pnpm install` and can be skipped, so CI checks the branch name and the commit messages again on every PR.

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
pnpm check:packages  # fails if a package lacks typecheck, test or build (pnpm -r would skip it)
pnpm typecheck       # tsc in every package, separate from any bundler
pnpm test            # vitest in every package; the hub runs in workerd
pnpm build
pnpm --filter @specreview/hub test   # one package; names: @specreview/hub, @specreview/site, @specreview/action, @jadedm/specreview (cli)
```

Library packages build with `tsconfig.build.json`, which leaves tests out of `dist/`; Vitest looks only in `src/` (the hub also in `test/`). `action` and `cli` run under Node from `dist/`, so they use `NodeNext` resolution and relative imports need `.js` extensions.
