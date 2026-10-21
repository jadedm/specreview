# An organisation's hub

The template for the private repo an organisation keeps for its specreview hub. The repo holds the hub's settings; a workflow applies them to the organisation's Cloudflare account on every push to `main`.

| File                          | Holds                                                                                  | Written by               |
| ----------------------------- | -------------------------------------------------------------------------------------- | ------------------------ |
| `specreview.config.json`      | the organisation, admins, this repo's name; sites and their people; optional `brand`   | you, then the admin page |
| `hub.json`                    | account id, hostname, Worker name, D1 database and R2 bucket names; the ids below them | you, then the workflow   |
| `specreview.commit`           | the full specreview commit to run                                                      | you                      |
| `.github/workflows/apply.yml` | runs `apply.sh` on pushes to `main` and by hand                                        | copied                   |
| `apply.sh`                    | setup, then deploy, committing `hub.json` after each                                   | copied                   |
| `run.sh`                      | fetches that commit fresh, builds the hub, runs one command; also for use on a laptop  | copied                   |

## Install

Private repos spend the organisation's GitHub Actions minutes: this repo's apply workflow and each product repo's docs workflow stop once the plan's included minutes are used up while the spending limit is zero, and do not start at all while the organisation's billing has failed (Settings, Billing and plans).

1. Create a private repo in the organisation's GitHub account from this template (or copy this folder into one, hidden files included: `.github/` and `.gitignore`). Until step 7, the apply workflow's runs (on this first push, or any push to `main`) fail for want of the token; that is expected.
2. Set `specreview.commit` to the commit a specreview release tag points to: `gh api repos/jadedm/specreview/commits/v0.5.0 --jq .sha` for `v0.5.0`, or the newest on the [releases page](https://github.com/jadedm/specreview/releases). run.sh stops with "set specreview.commit" until you do, refuses a commit that is on no branch of specreview, and names the release it runs (or warns that the commit is not one). Then check that each product repo's docs build, before any Cloudflare work: `./run.sh check-docs <path to a full clone of the product repo> --repo <its name>` (add `--docs <folder>` when the docs are not in `docs/`; a shallow clone is refused, since the build reads every page's history). It runs the site build the publish workflow runs, on the docs folder as committed, and stops at the first thing it refuses, naming the file; run it again after each fix. the docs folder takes Markdown pages and plain images, fonts, PDFs and text files, with no scripts or styles in pages (other HTML shows as text). It needs no token and publishes nothing.
3. Enable Zero Trust on the Cloudflare account (dashboard: Zero Trust, then the Free plan) and R2 (dashboard: R2 Object Storage; enabled once per account, and Cloudflare may ask for a payment method even on the free tier), and create the install token (below). Keep it in a file on your laptop; it never goes into GitHub. The sign-in page shows the organisation name set under Zero Trust, Custom pages, Access login page (Manage, Your Organization's name), and it is the same for every Access application on the account, so a separate Cloudflare account for the hub keeps it apart from the account's other apps.
4. Edit `hub.json`: `accountId` (the 32-character id on the Cloudflare dashboard), `hostname` (where the docs sites will live, in a zone on that account) and `adminHostname` (the admin page's own hostname, also in a zone on the account; a sibling such as `specs-admin.example.com` beside `specs.example.com` reads clearly). Leave the rest; setup writes the ids.
5. Edit `specreview.config.json`: `org` (the organisation's GitHub login, lowercase), `ownerId` (its numeric id: `gh api orgs/<org> --jq .id`, or the `id` at `https://api.github.com/orgs/<org>`), `configRepo` (the name of this repo; the admin page commits its changes here), and `admins` (the emails that may open the admin page). Leave `sites` empty: sites are added on the admin page once the hub is running (step 10).
6. From a laptop, with the install token: `./run.sh setup --token-file <file> --apply` (creates the Access apps and policy, the one-time PIN login, the database and the bucket, and records their ids in `hub.json`), then `./run.sh deploy --token-file <file>`.
7. Create the workflow's token: `./run.sh workflow-token --token-file <install token file> --out <new file>`, naming a file outside this repo (`/tmp/.cf-workflow-token`, say). It writes the new token to that file and nothing else, and prints the command that stores it as this repo's `CLOUDFLARE_API_TOKEN` Actions secret. Run that, then delete the file.
8. Commit and push to `main`. From now on the apply workflow applies every push.
9. Give the hub its GitHub App from the admin page's GitHub App tab (`https://<adminHostname>/_admin/github`, for the config's `admins`; see GitHub below), and install it on this repo, the product repos and the ticket repos. Until then the hub works but shows tickets as unavailable and sets no labels.
10. Add each site on the admin page's Sites tab. It opens two pull requests: one adding the site to `specreview.config.json` here, one adding the docs workflow to the product repo. Merge this repo's first, wait for its apply run to finish green, then merge the product repo's. Readers and approvers are then set on the People tab.

If a run fails part way, fix the cause and run it again: it resumes from the ids already recorded. If the workflow could not push `hub.json` (someone changed it at the same moment), it prints the file in the run's log; copy it into the repo by hand. If an id could not be recorded at all (the run was lost while creating something), setup refuses that resource and says what to add to `hub.json` by hand.

## Who can change the hub

Anyone with write access to this repo can get the Cloudflare token, two ways: a repository secret reaches workflows on any branch, and a writer can add one on theirs; and every push to `main` runs this repo's own `apply.sh` with the token, so a writer who changes it on `main` changes what runs. The hub's GitHub App writes here too (the readers and approvers form commits to the default branch, `main`), so whoever holds the app's key has the same reach. Give write access only to the people who administer the hub; product repos are separate, and their writers need no access here.

On GitHub's Free plan nothing more can be set for a private repo. Where the plan allows:

- GitHub Team or Enterprise: create an environment named `apply` limited to the `main` branch (Settings, Environments, Deployment branches), add `CLOUDFLARE_API_TOKEN` to it as an environment secret (`gh secret set CLOUDFLARE_API_TOKEN --env apply < <file>`, and the same when replacing the token later; `workflow-token` prints the repository form), delete the repository secret of that name, and add `environment: apply` to the `apply` job in `.github/workflows/apply.yml`. A workflow on another branch then gets no token, whether pushed or started by hand. A change pushed to `main` still runs with it.
- GitHub Enterprise Cloud: also add required reviewers to that environment. Every apply then waits for one of them. An approved run applies the newest `main`, not only the push that started it, so the reviewer reads everything on `main` since the last applied commit before approving. This holds the hub's own commits from the readers and approvers form too: an added person gets in once a reviewer approves the run, while a removal still refuses them at once.

A ruleset requiring pull requests on `main` does not fit this template: `apply.sh` commits `hub.json` to `main` and the readers and approvers form commits to the default branch, and both would be refused. Do not let GitHub Actions bypass such a rule either, since any workflow on any branch could then push to `main`.

## Cloudflare tokens

Two tokens. The workflow reads its token from the repo's secret (or the `apply` environment's, above); `run.sh` reads a token from a file at each call. Neither prints or stores it. Cloudflare's dashboard says Edit where its API says Write.

### Install token

Used from a laptop for the first install, for `workflow-token`, and for repairs the workflow's token cannot make (setup's error names the missing permission). Not stored in GitHub. Create it on the account (Manage account, Account API tokens), choosing this account and the hostname's zone:

- Account: Account Settings Read; Access: Apps and Policies Write; Access: Organizations, Identity Providers, and Groups Write; D1 Write; Workers R2 Storage Write; Workers Scripts Write; Account API Tokens Write, for `workflow-token` (or API Tokens Write (for a user token), if you make it under your profile instead).
- Zone (the hostname's zone): Zone Read; DNS Read; Workers Routes Write.

### Workflow token

What `workflow-token` creates, scoped to this account and the hostname's zone: everything a run on an installed hub does, and not the login methods (identity providers are Read, since only the first install creates the one-time PIN login).

- Account: Account Settings Read; Access: Apps and Policies Write; Access: Organizations, Identity Providers, and Groups Read; D1 Write; Workers R2 Storage Write; Workers Scripts Write.
- Zone: Zone Read; DNS Read; Workers Routes Write.

Cloudflare cannot limit these permissions to the hub's own resources, so this token can change every Access application, D1 database, R2 bucket and Worker on the account; a separate Cloudflare account for the hub is the way to keep that reach to the hub. To replace it: run `workflow-token` again with a new file, store the new value (in the `apply` environment if the token lives there), then delete the old token in the dashboard.

## GitHub

The hub talks to GitHub as a GitHub App owned by the organisation, created from the hub's admin page (on `adminHostname`): it opens GitHub's form with the permissions filled in, and the hub keeps the app's key in its database. Install it on the ticket repos, this repo and the product repos (the admin page links the install page). An app made by hand works too: set its id and `.pem` key with `run.sh secret` (below). The hub mints a token per ticket repo, with Issues read for reading tickets and Issues write for labels. A hub without the app can use two fine-grained personal tokens instead (`GITHUB_READ_TOKEN` with Issues read, `GITHUB_WRITE_TOKEN` with Issues read and write); if both kinds are set, the app wins.

## Changes later

Edit and commit to `main`; the workflow applies it.

- Readers, approvers, admins or sites: `specreview.config.json`, or the admin page, which commits to it. setup brings the Access policy to exactly what the config says, removals included. A site whose tickets live in several repos lists them as `"ticketRepos": ["web", "backend"]` in place of `ticketRepo` (the first is the default: a page's `issues: [3, "backend#4"]` links web#3 and backend#4; changing or reordering the first entry moves every bare number already published to the new first repo, so add repos after it), and the hub's GitHub App must be installed on each. A site added by hand needs its repo's numeric id as `repositoryId` (`gh api repos/<org>/<repo> --jq .id`); the admin page fills it in.
- The organisation's name and logo in each site's header: `"brand": { "name": "Acme", "logo": "logo.png" }` in `specreview.config.json`, with the PNG or WebP (at most 256 KB) beside it. Leave out `logo` for the name alone, or `brand` for neither.
- The admin page lives only on `adminHostname` (#75). A hub set up before that has no admin page until `adminHostname` is added to `hub.json` and pushed: the apply run checks the name is free, creates its Access application for the admins, and deploys the second hostname. `/_admin/` on the docs hostname then points there. Removing `adminHostname` deletes its Access application and policy; then remove the hostname from the hub's Worker in the Cloudflare dashboard (Workers, the Worker, Domains), since a deploy may leave it attached. To rename it, remove it in one push and add the new name in the next.
- Upgrading: set `specreview.commit` to the new release's commit and push; the apply run deploys it, and the hub keeps accepting publishes from the commit it ran before (deploy records both in `hub.json`, as `deployedCommit` and `previousCommit`). Then move each product repo's pin in `.github/workflows/docs.yml` (`jadedm/specreview/.github/workflows/publish-docs.yml@`) to the same commit: the admin page's Sites tab shows which sites are on another commit and opens a pull request moving them; merge it before the next upgrade, after which the older commit no longer publishes. From v0.5.0 the hub takes publishes only from that reusable workflow, so a product repo whose workflow still runs the `build` and `publish` actions in two jobs of its own does not publish until it moves: the Sites tab's "Move to the reusable workflow" opens a pull request replacing its workflow with the caller, keeping its docs folder, its left-out and prototype paths, and the runner its jobs used (`runs-on`: one label or a `[list]` of them, of letters, digits, `.`, `_` and `-`, the same in both jobs; a runner group or an expression is refused, and can be set by hand as the caller's `runner` input). Migrations only add, so the previous Worker keeps working on the newer schema.
- Rolling back the Worker: `npx wrangler rollback --name <worker>` from a checkout, with the token in `CLOUDFLARE_API_TOKEN`. Migrations are not rolled back.

## From a laptop

`run.sh` runs one command against the hub, with the token in a file:

```
./run.sh setup --token-file <file>             # reads only; prints what it would create
./run.sh setup --token-file <file> --apply     # creates it; commit hub.json
./run.sh deploy --token-file <file> --dry-run  # builds, calls nothing
./run.sh deploy --token-file <file>            # migrations, then the Worker on the hostname
./run.sh secret --token-file <file> --name GITHUB_APP_ID --value-file <file>
./run.sh secret --token-file <file> --name GITHUB_APP_PRIVATE_KEY --value-file <file>
./run.sh workflow-token --token-file <file> --out <new file>  # the workflow's token, into a new file
./run.sh check-docs <product repo> --repo <name> [--docs docs]  # builds its docs, publishes nothing
```

Run setup from one place at a time: not from a laptop while the workflow runs. Each run fetches the pinned commit into a new temporary folder and deletes it after; a `.specreview` folder left by an older `run.sh` is no longer used and can be deleted.

setup refuses, and changes nothing, when it finds something it did not create where it expects its own resources: an Access app, D1 database or bucket with the expected name but no id in `hub.json`, extra Access policies or rules, a hostname another Worker or DNS record already uses, any other Access app over the hub's hostnames or a path under them (it could open or shadow part of the hub), or sign-in through WARP on the hostname's or the admin app.
