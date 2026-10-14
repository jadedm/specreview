# An organisation's hub

The template for the private repo an organisation keeps for its specreview hub. The repo holds the hub's settings; a workflow applies them to the organisation's Cloudflare account on every push to `main`.

| File                          | Holds                                                                                  | Written by             |
| ----------------------------- | -------------------------------------------------------------------------------------- | ---------------------- |
| `specreview.config.json`      | sites, team domains, approvers, readers, admins; optional `brand` (name, logo file)    | you                    |
| `hub.json`                    | account id, hostname, Worker name, D1 database and R2 bucket names; the ids below them | you, then the workflow |
| `specreview.commit`           | the full specreview commit to run                                                      | you                    |
| `.github/workflows/apply.yml` | runs `apply.sh` on pushes to `main` and by hand                                        | copied                 |
| `apply.sh`                    | setup, then deploy, committing `hub.json` after each                                   | copied                 |
| `run.sh`                      | checks out that commit, builds the hub, runs one command; also for use on a laptop     | copied                 |

## Install

1. Create a private repo in the organisation's GitHub account from this template (or copy this folder into one, hidden files included: `.github/` and `.gitignore`). Until step 6, the apply workflow's runs (on this first push, or any push to `main`) fail for want of the token; that is expected.
2. Enable Zero Trust on the Cloudflare account (dashboard: Zero Trust, then the Free plan), and create the install token (below). Keep it in a file on your laptop; it never goes into GitHub.
3. Edit `hub.json`: `accountId` (the 32-character id on the Cloudflare dashboard) and `hostname` (where the hub will live, in a zone on that account). Leave the rest; setup writes the ids.
4. Edit `specreview.config.json` for your sites and people, and set `specreview.commit` to a release commit of specreview (run.sh stops with "set specreview.commit" until you do).
5. From a laptop, with the install token: `./run.sh setup --token-file <file> --apply` (creates the Access apps and policy, the one-time PIN login, the database and the bucket, and records their ids in `hub.json`), then `./run.sh deploy --token-file <file>`.
6. Create the workflow's token: `./run.sh workflow-token --token-file <install token file> --out <new file>`, naming a file outside this repo (`/tmp/.cf-workflow-token`, say). It writes the new token to that file and nothing else, and prints the command that stores it as this repo's `CLOUDFLARE_API_TOKEN` Actions secret. Run that, then delete the file.
7. Commit and push to `main`. From now on the apply workflow applies every push.
8. Give the hub its GitHub App from the hub's admin page (`/_admin/`, for the config's `admins`; see GitHub below). Until then the hub works but shows tickets as unavailable and sets no labels.

If a run fails part way, fix the cause and run it again: it resumes from the ids already recorded. If the workflow could not push `hub.json` (someone changed it at the same moment), it prints the file in the run's log; copy it into the repo by hand. If an id could not be recorded at all (the run was lost while creating something), setup refuses that resource and says what to add to `hub.json` by hand.

## Who can change the hub

Anyone with write access to this repo can get the Cloudflare token: the secret reaches workflows on any branch, and a writer can change the workflow on theirs. Branch protection on `main` does not change that. Give write access only to the people who administer the hub; product repos are separate, and their writers need no access here. On a paid GitHub plan, a deployment environment limited to `main` holding the secret closes this.

## Cloudflare tokens

Two tokens. The workflow reads its token from the repo's secret; `run.sh` reads a token from a file at each call. Neither prints or stores it. Cloudflare's dashboard says Edit where its API says Write.

### Install token

Used from a laptop for the first install, for `workflow-token`, and for repairs the workflow's token cannot make (setup's error names the missing permission). Not stored in GitHub. Create it on the account (Manage account, Account API tokens), choosing this account and the hostname's zone:

- Account: Account Settings Read; Access: Apps and Policies Write; Access: Organizations, Identity Providers, and Groups Write; D1 Write; Workers R2 Storage Write; Workers Scripts Write; Account API Tokens Write, for `workflow-token` (or API Tokens Write (for a user token), if you make it under your profile instead).
- Zone (the hostname's zone): Zone Read; DNS Read; Workers Routes Write.

### Workflow token

What `workflow-token` creates, scoped to this account and the hostname's zone: everything a run on an installed hub does, and not the login methods (identity providers are Read, since only the first install creates the one-time PIN login).

- Account: Account Settings Read; Access: Apps and Policies Write; Access: Organizations, Identity Providers, and Groups Read; D1 Write; Workers R2 Storage Write; Workers Scripts Write.
- Zone: Zone Read; DNS Read; Workers Routes Write.

Cloudflare cannot limit these permissions to the hub's own resources, so this token can change every Access application, D1 database, R2 bucket and Worker on the account; a separate Cloudflare account for the hub is the way to keep that reach to the hub. To replace it: run `workflow-token` again with a new file, store the new value, then delete the old token in the dashboard.

## GitHub

The hub talks to GitHub as a GitHub App owned by the organisation, created from the hub's admin page (`/_admin/`): it opens GitHub's form with the permissions filled in, and the hub keeps the app's key in its database. Install it on the ticket repos, this repo and the product repos (the admin page links the install page). An app made by hand works too: set its id and `.pem` key with `run.sh secret` (below). The hub mints a token per ticket repo, with Issues read for reading tickets and Issues write for labels. A hub without the app can use two fine-grained personal tokens instead (`GITHUB_READ_TOKEN` with Issues read, `GITHUB_WRITE_TOKEN` with Issues read and write); if both kinds are set, the app wins.

## Changes later

Edit and commit to `main`; the workflow applies it.

- Readers, approvers, admins or sites: `specreview.config.json`. setup brings the Access policy to exactly what the config says, removals included.
- The organisation's name and logo in each site's header: `"brand": { "name": "Acme", "logo": "logo.png" }` in `specreview.config.json`, with the PNG or WebP (at most 256 KB) beside it. Leave out `logo` for the name alone, or `brand` for neither.
- Upgrading: change `specreview.commit`. Migrations only add, so the previous Worker keeps working on the newer schema.
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
```

Run setup from one place at a time: not from a laptop while the workflow runs.

setup refuses, and changes nothing, when it finds something it did not create where it expects its own resources: an Access app, D1 database or bucket with the expected name but no id in `hub.json`, extra Access policies or rules, or a hostname another Worker or DNS record already uses.
