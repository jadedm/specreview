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

| Package           | What it is                                                                          | Ticket     |
| ----------------- | ----------------------------------------------------------------------------------- | ---------- |
| `packages/hub`    | The Cloudflare Worker an org deploys: API, comments, status, labels, serving sites  | #3, #4, #6 |
| `packages/site`   | `specreview-site build`: VitePress config, review UI and manifest for a repo's docs | #15        |
| `packages/shared` | Text rules and manifest validation used by both the hub and the site build          | #15        |
| `packages/action` | The publish GitHub Action                                                           | #5         |
| `packages/cli`    | `@jadedm/specreview`: init, add a site, create the GitHub App                       | #7         |

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
pnpm --filter @specreview/hub test   # one package; names: @specreview/hub, @specreview/site, @specreview/shared, @specreview/action, @jadedm/specreview (cli)
```

`@specreview/shared` resolves types from `src/` and runtime from `dist/`; the hub's and site's Vitest configs alias it to `src/` so tests run before the build, and `pnpm -r build` builds it first. `happy-dom` is a root dev dependency on purpose: installed in one package only, pnpm makes a second Vitest variant and the hub's Workers pool fails with "Vitest failed to find the runner" (a stale `node_modules` can keep the old variant; reinstall clean).

Library packages build with `tsconfig.build.json`, which leaves tests out of `dist/`; Vitest looks in `src/` (the hub and site also in `test/`). `action` and `cli` run under Node from `dist/`, so they use `NodeNext` resolution and relative imports need `.js` extensions.

## Site build (packages/site)

- `specreview-site build --repo <name> [--docs docs] [--out .specreview]`, run from inside the product repo. It builds the docs folder **as committed at HEAD**: `git archive` exports it to a temp folder, so no uncommitted, untracked or gitignored file can be published and the manifest's commit is exactly what was built. A throwaway VitePress root (config and theme from this package's `dist/`) builds the export; Vue resolves to this package's copy because a product repo has no `node_modules`.
- Refused, naming the file: symlinks and submodules in the docs tree; names outside the hub router's grammar (`[A-Za-z0-9._~-]`, no leading dot, no leading `_api`/`_history`, checked after `public/` maps to the site root); in `public/` anything but png, jpg, jpeg, gif, webp, ico, pdf, txt, csv, woff, woff2 (HTML, scripts or SVG would run in the site's origin); includes anywhere (they expand before Markdown, code included); snippet imports, `<script>` and `<style>` outside code; a missing `index.md` at HEAD; a shallow clone.
- Front matter may hold only `title`, `order` and `issues` (VitePress acts on others: `head` adds scripts, `layout` and `hero` render HTML). The `{...}` attribute syntax is off (it would pass Vue directives to the compiler). The only inline scripts allowed into a page are VitePress's macOS check and its data script; any other fails the build rather than being hashed into the CSP.
- Every rendered page passes an allowlist sanitizer (`src/build/sanitize.ts`, `sanitize-html`) before Vue compiles it: only the tags, attributes and styles VitePress's own output for plain Markdown uses (a test renders every feature and checks nothing is lost), http, https, mailto or relative URLs, and braces in text as entities. VitePress plugins put page text into the template unescaped (code-group and alert titles, the code language label); this catches them and any others. Sidebar titles are HTML-escaped (VitePress shows them with `v-html`). Front matter in a language other than YAML (`---js`) is refused before anything parses it: gray-matter would evaluate it on the build machine. A Vite plugin (`confineTo`) refuses to load any file outside the export, this package, and the one `node_modules` tree it was installed into, so an image or import cannot publish another repo or runner file.
- `--out` must be a folder inside the repo, not the repo, `.git`, the docs folder or anything holding it, and is emptied only if empty or marked by an earlier build (`.specreview-output`). A failed build leaves no `site/` behind.
- Output: `<out>/site/` (base `/<repo>/`, clean URLs, raw HTML off, sidebar from the folder tree, `manifest.json` with the CSP hashing every inline script of every page, validated by `@specreview/shared` and at most 5 MB) and `<out>/history/<commit>/<path>.md`. History follows renames and first-parent merges, keeps only versions inside the docs folder and drops old names the hub cannot serve. A repo using SHA-256 object names is refused (the hub takes 40-hex commits).
- Review UI (`src/theme/review/`): every call under `<base>_api/` and `<base>_history/`; page data from `_api/pages`; `/folder/` is `folder/index`, `/folder` is `folder` when that page exists; authors, `mine`, ticket titles and history rendered only as the hub sends them; a write that finishes after navigation redraws nothing; the status board under the index page.
- Tests: `pnpm --filter @specreview/site test` builds the shared package and this one, then runs unit tests and `test/build.test.ts`, which runs the built command on throwaway git repos.
- Browser smoke: `pnpm build`, then `OUT=$(packages/site/scripts/smoke-fixture.sh)` (builds `test/smoke-docs` as site `sidecar` from a fresh repo), then `SMOKE_SITE=$OUT node packages/hub/scripts/smoke-server.mjs`, and open `http://127.0.0.1:8796/__smoke/login?email=riya@ariai.example` (a stand-in for Access that signs a token from a cookie).

## Hub (packages/hub)

One hub per org: each org deploys its own Worker in its own Cloudflare account, on its own domain, behind one Access application. Each of the org's repos is a site at `/<repo>/`.

- Config: `SPECREVIEW_CONFIG` is the JSON of the org's `specreview.config.json`: `org`, `accessTeamDomain`, `accessAud` (the hub's one Access application), `admins`, an optional `teamLabel`, and per site `repo` (bare name), `teamDomains`, `approvers`, `readers`, `ticketRepo` (a repo of the same org), optional `teamLabel`. It is validated before anything else; any problem answers 500 `CONFIG_INVALID` to every request, `/` included. Rules (`src/config.ts`; `test/config.test.ts` breaks one rule per case): lowercase names, unique repos, sites sharing a ticket repo have the same team, no public mail domain as a team or reader domain (a blocklist of common providers and their regional domains, best effort), approvers inside the team domains, readers lowercase exact emails or `@domain`, admins non-empty and unique, `teamLabel` 1 to 40 code points with something visible, no control, unassigned or private-use characters, separators or bidi overrides, no outer spaces, no `@` and not `You` or `Reader` (after NFKC folding and removing invisible characters; lookalike letters from other scripts are not caught), no unknown keys. `readers` is interim until the admin page (#12) keeps them in D1 and keeps Access in sync.
- Identifiers: URL paths and store keys use the bare repo; database rows use `<org>/<repo>` (`site.key`); GitHub calls use `<org>/<ticketRepo>`.
- Paths: `/<repo>/` then `_api/...`, `_history/<40-hex commit>/<path>.md`, or a page. `/<repo>` without a slash, a doubled slash, and anything not under an exact configured repo are 404 before any identity check. Segments are `[A-Za-z0-9._~-]`, split and never decoded; URL parsing has already resolved dot segments.
- Access: the token's audience is the hub's. Role per site: `approver` and `team` by team domain, `reader` by exact email or `@domain` (exact match on the part after `@`), otherwise `none`. Token emails are trimmed and lowercased. A signed-in caller who may not read a site gets 403 on every routable path of it, before anything is read from the store or the database (malformed paths are 404 and a missing token 401 first).
- What readers see (`src/identity.ts`): never another person's email or a ticket title. In comments (authors, reply authors, `resolvedBy`) a stored email becomes `You` (with `mine: true`), the site's `teamLabel` (site, then hub, then `<org> team`) for anyone who is team on the site now, or `Reader`; page status `changedBy` gets the same labels without `mine`. `resolvedPr` is team only. Tickets lose `title` and `url`. `GET _api/pages` gives the UI the snapshot's `commit` and each page's title, hash, issues and sections (`id`, `title`, `text` only, for everyone), plus history (authors, PRs) for the team only; it replaces reading `manifest.json`. Team and approvers see emails, ticket titles and links, PRs and history. Every ticket's labels are filtered to our three exact status labels.
- Pages: served from the store at `<repo>/v/<version>/`: `a/b` tries `a/b.html`, `a/b/index.html`, then the file `a/b`, except that a path ending in an extension from the content-type table tries the file first (`a/e.js`, then `a/e.js.html`, then `a/e.js/index.html`); a dot elsewhere (`release-1.2`) is a clean URL; a trailing slash is the directory index. GET and HEAD only. Content types from a fixed table; anything else downloads (`octet-stream`, `attachment`). Pages and assets are `private, no-store`, with nosniff, `same-origin` referrer, frame `DENY`, and the CSP from the manifest (default `default-src 'self'`). History (GET only) is the same with `default-src 'none'`; API and error responses are `no-store` with `default-src 'none'`.
- Store (`src/store.ts`, binding `SITES`, R2): `<repo>/current.json` names the live version (`<40-hex>-<run id>`, written last by a publish), `<repo>/v/<version>/` holds the build and `manifest.json`, `<repo>/history/<commit>/<path>.md` old pages. A request or a reconcile takes one snapshot (pointer then manifest) and uses it throughout (`ctx.snapshot()`). Commits are 40-hex (SHA-1 repos only). Pointers are cached 10 s per repo, single flight, failures not cached; manifests by repo and version, never evicted (#9 measures it). No pointer is 503 `SITE_NOT_PUBLISHED` and links nothing; a bad pointer or manifest is 503 `SITE_BROKEN` and fails the label sync for its ticket repo, so nothing is cleared. Any store error is a generic 503 `STORAGE_UNAVAILABLE`. Without the binding, any route that reads the store answers 500 `STORE_NOT_CONFIGURED`. `manifest.json` is never served as a page: its history entries (authors, PRs) are for the team.
- Sites of one org share an origin. Script in one repo's built pages runs with the viewer's sign-in on every site of the hub: for a viewer of both, it can comment, resolve threads, sign pages off as ready, and read team-only history on another repo. The origin check and the CSP do not stop it, and a `Referer` is forgeable within an origin. Accepted: every site is the same org's docs, published from its own repos. A separate subdomain per site would be the fix. Orgs are separated by separate deployments.
- Every table is keyed by `site` (the ticket cache by ticket repo, since sites can share one), and every query filters on it; replies reference threads by `(site, thread_id)`. Ticket labels are computed per ticket repo across every site that files tickets there, and the hub creates its three labels in a repo the first time it needs them. A cron every 5 minutes (`wrangler.jsonc`) reconciles each ticket repo on its own, repairing failed or overlapping syncs and clearing labels from tickets no page links.
- `SiteStore` and `GitHubAuth` (tokens per repo, the GitHub App in #6) are interfaces; tests use `memoryStore`. `createHub((env) => deps)` builds the Worker around them.
- Live smoke (loop step 7): `pnpm --filter @specreview/hub build`, then `node packages/hub/scripts/smoke-server.mjs` (the built Worker in workerd on 127.0.0.1:8797 with a fresh D1, a seeded local R2, and stubs for Access keys and GitHub) and `packages/hub/scripts/smoke.sh` (curls; exits 1 on any miss). Stop the server with Ctrl-C; it uses Miniflare 4, pinned, because the 5.x alpha under wrangler takes different options.
- Tests: `test/helpers.ts` sets up one org with three sites (two sharing a team and ticket repo), all published at `VERSION` by `publishedFiles()`. `call('/api/x', { site })` maps onto a site; `raw: true` sends a path as is. `setClockForTests` moves the pointer cache's clock.
