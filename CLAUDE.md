# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# specreview

Review specs where they are rendered. Teams keep Markdown in each repo's `docs/`; specreview publishes each repo as a site on one hub the org hosts on its own Cloudflare account and domain, where readers comment on selected text and product signs pages off; the sign-off shows on linked GitHub issues as a label. Open source (MIT), self-hosted only. Plan and domain model: issue #1.

Every change: an issue first, then a test plan on the issue before code, a branch, a PR, the full local gate before each push, and review before merge.

## Branches

Gitflow. `develop` is the integration branch and the GitHub default; `main` takes releases only. Branches are `<prefix>/<issue>-<slug>` (prefix one of feature, bugfix, hotfix, chore, fix, ci, infra, refactor, docs) or `release/<x.y.z>`, cut from `develop`; always pass `--base develop` to `gh pr create`. Husky refuses env files at commit, non-conventional commit messages, and pushes to `develop`, `main` or a badly named branch (tags pass). Hooks are installed by `pnpm install` and can be skipped, so CI checks the branch name and the commit messages again on every PR.

Solo repo for now: loop step 12 (team review) is N/A.

## Layout

pnpm workspace, one package per part:

| Package           | What it is                                                                         | Ticket     |
| ----------------- | ---------------------------------------------------------------------------------- | ---------- |
| `packages/hub`    | The Cloudflare Worker an org deploys: API, comments, status, labels, serving sites | #3, #4, #6 |
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

One hub per org: each org deploys its own Worker in its own Cloudflare account, on its own domain, behind one Access application. Each of the org's repos is a site at `/<repo>/`.

- Config: `SPECREVIEW_CONFIG` is the JSON of the org's `specreview.config.json`: `org`, `accessTeamDomain`, `accessAud` (the hub's one Access application), `admins`, and per site `repo` (bare name), `teamDomains`, `approvers`, `readers`, `ticketRepo` (a repo of the same org). It is validated before anything else; any problem answers 500 `CONFIG_INVALID` to every request, `/` included. Rules (`src/config.ts`; `test/config.test.ts` breaks one rule per case): lowercase names, unique repos, sites sharing a ticket repo have the same team, no public mail domain as a team or reader domain (a blocklist of common providers and their regional domains, best effort), approvers inside the team domains, readers lowercase exact emails or `@domain`, admins non-empty and unique, no unknown keys. `readers` is interim until the admin page (#12) keeps them in D1 and keeps Access in sync.
- Identifiers: URL paths and store keys use the bare repo; database rows use `<org>/<repo>` (`site.key`); GitHub calls use `<org>/<ticketRepo>`.
- Paths: `/<repo>/` then `_api/...`, `_history/<40-hex commit>/<path>.md`, or a page. `/<repo>` without a slash, a doubled slash, and anything not under an exact configured repo are 404 before any identity check. Segments are `[A-Za-z0-9._~-]`, split and never decoded; URL parsing has already resolved dot segments.
- Access: the token's audience is the hub's. Role per site: `approver` and `team` by team domain, `reader` by exact email or `@domain` (exact match on the part after `@`), otherwise `none`. Token emails are trimmed and lowercased. Someone who may not read a site gets 403 on every path of it before anything is read from the store or the database.
- Pages: served from the store at `<repo>/v/<version>/`: `a/b` tries `a/b.html`, `a/b/index.html`, then the file `a/b`; a trailing slash is the directory index. GET and HEAD only. Content types from a fixed table; anything else downloads (`octet-stream`, `attachment`). Pages and assets are `private, no-store`, with nosniff, `same-origin` referrer, frame `DENY`, and the CSP from the manifest (default `default-src 'self'`). History is the same with `default-src 'none'`; API and error responses are `no-store` with `default-src 'none'`.
- Store (`src/store.ts`, binding `SITES`, R2): `<repo>/current.json` names the live version (`<40-hex>-<run id>`, written last by a publish), `<repo>/v/<version>/` holds the build and `manifest.json`, `<repo>/history/<commit>/<path>.md` old pages. A request or a reconcile takes one snapshot (pointer then manifest) and uses it throughout (`ctx.snapshot()`). Pointers are cached 10 s per repo, single flight, failures not cached; manifests by repo and version, never evicted (#9 measures it). No pointer is 503 `SITE_NOT_PUBLISHED` and links nothing; a bad pointer or manifest is 503 `SITE_BROKEN` and fails the label sync for its ticket repo, so nothing is cleared. Any store error is a generic 503 `STORAGE_UNAVAILABLE`. Without the binding, any route that reads the store answers 500 `STORE_NOT_CONFIGURED`. `manifest.json` is never served as a page: its history entries (authors, PRs) are for the team.
- Sites of one org share an origin. Script in one repo's built pages runs with the viewer's sign-in on every site of the hub: for a viewer of both, it can comment, resolve threads, sign pages off as ready, and read team-only history on another repo. The origin check and the CSP do not stop it, and a `Referer` is forgeable within an origin. Accepted: every site is the same org's docs, published from its own repos. A separate subdomain per site would be the fix. Orgs are separated by separate deployments.
- Every table is keyed by `site` (the ticket cache by ticket repo, since sites can share one), and every query filters on it; replies reference threads by `(site, thread_id)`. Ticket labels are computed per ticket repo across every site that files tickets there, and the hub creates its three labels in a repo the first time it needs them. A cron every 5 minutes (`wrangler.jsonc`) reconciles each ticket repo on its own, repairing failed or overlapping syncs and clearing labels from tickets no page links.
- `SiteStore` and `GitHubAuth` (tokens per repo, the GitHub App in #6) are interfaces; tests use `memoryStore`. `createHub((env) => deps)` builds the Worker around them.
- Tests: `test/helpers.ts` sets up one org with three sites (two sharing a team and ticket repo), all published at `VERSION` by `publishedFiles()`. `call('/api/x', { site })` maps onto a site; `raw: true` sends a path as is. `setClockForTests` moves the pointer cache's clock.
