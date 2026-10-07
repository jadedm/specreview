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

## Hub (packages/hub)

- Config: `SPECREVIEW_CONFIG` is the JSON of the team's `specreview.config.json` (`accessTeamDomain`, and per site `repo`, `accessAud`, `teamDomains`, `approvers`, `ticketRepo`). It is validated before anything else; any problem answers 500 `CONFIG_INVALID` to every request, `/` included. Rules (`src/config.ts`, one test each in `test/config.test.ts`): canonical repos, unique repos and audiences, a `ticketRepo` under the site's own owner, sites sharing a ticket repo have the same team, no public mail domain as a team domain, approvers inside the team domains, no unknown keys.
- Paths: a site is `/<owner>/<repo>/` with its canonical lowercase key; its API is `_api/...` and old versions `_history/<40-hex commit>/<path>.md`. Anything that is not an exact configured site is 404 before any identity check. The path is split, never decoded, so `%2F` and similar never become structure; URL parsing has already resolved dot segments.
- Identity: the Access token's audience must be the site's own `accessAud`, so a token for one site is refused on every other. Team and approvers come from the site's config. Pages are protected by one Access application per site path, which the Worker cannot see; that is checked by the live smoke.
- Every table is keyed by `site` (the ticket cache by ticket repo, since sites can share one), and every query filters on it; replies reference threads by `(site, thread_id)`. Ticket labels are computed per ticket repo across every site that files tickets there, and the hub creates its three labels in a repo the first time it needs them. A cron every 5 minutes (`wrangler.jsonc`) reconciles each ticket repo on its own, repairing failed or overlapping syncs and clearing labels from tickets no page links.
- `SiteStore` (manifests and old versions now; pages in #4) and `GitHubAuth` (tokens per repo) are interfaces: R2 in #4 and the GitHub App in #6; tests use `memoryStore`. `createHub((env) => deps)` builds the Worker around them; the default export has no store yet and answers `STORE_NOT_CONFIGURED`.
- Tests: `test/helpers.ts` sets up three sites (two sharing a team and ticket repo). `call('/api/x', { site })` maps onto a site; `raw: true` sends a path as is.
