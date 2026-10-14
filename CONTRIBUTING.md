# Contributing

Thanks for looking. specreview is small and run by one maintainer, so the process below is what keeps a change reviewable.

## Where things go

- Questions and ideas that are not yet a plan: [Discussions](https://github.com/jadedm/specreview/discussions).
- A bug or a feature request: an issue, using one of the forms.
- A vulnerability: not an issue. See `SECURITY.md`.

## Making a change

1. **An issue first.** Say what is wrong or missing and why. For anything beyond a typo, wait for a reply before writing code, so the change fits the plan on issue #1.
2. **A test plan on the issue, before code.** A short table of cases, each with what should happen: the normal path, who may and may not do it, and the edge and failure cases. A case caught here costs nothing.
3. **A branch from `develop`**, named `<prefix>/<issue>-<slug>`, for example `fix/42-empty-sidebar`. Prefixes: `feature`, `bugfix`, `hotfix`, `chore`, `fix`, `ci`, `infra`, `refactor`, `docs`.
4. **Commits** follow Conventional Commits with one scope: `fix(hub): keep a site's own 404 page`. The body says what went wrong and why the fix is shaped the way it is, not what the diff shows.
5. **The local gate** (below) passes before every push.
6. **A pull request to `develop`.** The template asks for the issue, what changed and why, the tests, and the smoke run. Pull requests from forks run CI after a maintainer approves the run.

`main` takes releases only. Changes reach it from `develop`.

## Setup

Node 22.13 or later, pnpm 10 (`corepack enable` gives you the version in `package.json`), and `jq` and `curl` for the smoke scripts.

```
pnpm install --frozen-lockfile
```

Installing sets up git hooks. They refuse a commit that adds an env file, a commit message that is not conventional, a push to `develop` or `main`, and a push from a branch named any other way; before a push they run `pnpm typecheck`. CI checks the same rules again.

## The local gate

The same steps CI runs:

```
pnpm lint:check      # pnpm lint fixes what it can; lint:check only reports
pnpm format:check    # pnpm format rewrites
pnpm check:packages
pnpm typecheck
pnpm test
pnpm build
```

If `pnpm build` changes `publish/dist/`, commit it: the publish action runs that bundle without installing anything, and CI fails when it differs from its source.

One package, or one file:

```
pnpm --filter @specreview/hub test
pnpm --filter @specreview/hub exec vitest run --project worker test/routing.test.ts
pnpm --filter @specreview/hub exec vitest run --project deploy deploy/setup.test.ts
pnpm --filter @specreview/site exec vitest run src/build/sidebar.test.ts
```

The hub's `worker` tests run inside workerd, the Workers runtime, with a fresh local D1 database; its `deploy` tests run in Node.

## Smoke tests

A change to how the hub answers requests is checked against the built Worker over real HTTP, not only in tests. After `pnpm build`:

```
node packages/hub/scripts/smoke-server.mjs        # leave it running
bash packages/hub/scripts/smoke.sh                # in another terminal; exits 1 on any miss
```

The server runs the built Worker in workerd with stand-ins for Cloudflare Access and GitHub, on ports 8796 to 8799. For the admin page's readers and approvers, start it as `SMOKE_APP=1 node packages/hub/scripts/smoke-server.mjs` (fresh) and run `bash packages/hub/scripts/smoke-access.sh`.

To look at a built site in a browser:

```
OUT=$(packages/site/scripts/smoke-fixture.sh)
SMOKE_SITE=$OUT node packages/hub/scripts/smoke-server.mjs
```

then open `http://127.0.0.1:8796/__smoke/login?email=riya@initech.example`. Stop the server with Ctrl-C.

Say in the pull request which smoke runs you did and what they showed.

## Code

- TypeScript throughout. Lint refuses `any`, unused variables, and `console` other than `console.error` outside `packages/cli`.
- The site build's refusals and the hub's access checks are the product's security. A change that loosens either needs a test that shows what is still refused.
- New dependencies need a reason in the pull request.
- Names of real organisations, hostnames and email addresses do not go in this repo; tests use `acme`, `initech` and `example` names.

`CLAUDE.md` holds the maintainers' detailed notes on each part.

## Licence of contributions

A contribution is licensed as the package it changes: GNU AGPL v3.0 only for `packages/hub` (`packages/hub/LICENSE`), MIT for everything else (`LICENSE`). There is no separate agreement to sign.
