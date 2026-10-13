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

1. Create a private repo in the organisation's GitHub account from this template (or copy this folder into one, hidden files included: `.github/` and `.gitignore`).
2. Enable Zero Trust on the Cloudflare account (dashboard: Zero Trust, then the Free plan), and create an API token with the permissions below.
3. In the new repo: Settings, Secrets and variables, Actions, add `CLOUDFLARE_API_TOKEN` with the token.
4. Edit `hub.json`: `accountId` (the 32-character id on the Cloudflare dashboard) and `hostname` (where the hub will live, in a zone on that account). Leave the rest; the workflow writes the ids.
5. Edit `specreview.config.json` for your sites and people, and set `specreview.commit` to a release commit of specreview (the run stops with "set specreview.commit" until you do).
6. Commit to `main`. The apply workflow runs (or start it from the Actions tab, "apply", "Run workflow"). It creates the Access apps and policy, the database and the bucket, records their ids in `hub.json`, and deploys the hub.

7. Give the hub its GitHub App: create the app (see GitHub below), pull the workflow's commits to `hub.json`, and from a laptop run `./run.sh secret` for `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY`. Until then the hub works but shows tickets as unavailable and sets no labels.

If a run fails part way, fix the cause and run it again: it resumes from the ids already recorded. If the workflow could not push `hub.json` (someone changed it at the same moment), it prints the file in the run's log; copy it into the repo by hand. If an id could not be recorded at all (the run was lost while creating something), setup refuses that resource and says what to add to `hub.json` by hand.

## Who can change the hub

Anyone with write access to this repo can get the Cloudflare token: the secret reaches workflows on any branch, and a writer can change the workflow on theirs. Branch protection on `main` does not change that. Give write access only to the people who administer the hub; product repos are separate, and their writers need no access here. On a paid GitHub plan, a deployment environment limited to `main` holding the secret closes this.

## Cloudflare token

The workflow reads it from the repo's secret; `run.sh` reads it from a file at each call. Neither prints or stores it. Permissions:

- Account: Account Settings Read; Access: Apps and Policies Edit; Access: Organizations, Identity Providers, and Groups Edit; D1 Edit; Workers R2 Storage Edit; Workers Scripts Edit.
- Zone (the hostname's zone): Zone Read; DNS Read; Workers Routes Edit.

## GitHub

The hub talks to GitHub as a GitHub App owned by the organisation: repository permissions Issues read and write and Metadata read, no webhook, installed on the ticket repos. Its id is on the app's settings page; the private key is the `.pem` file GitHub downloads. Set both on the hub with `run.sh secret` (below). The hub mints a token per ticket repo, with Issues read for reading tickets and Issues write for labels. A hub without the app can use two fine-grained personal tokens instead (`GITHUB_READ_TOKEN` with Issues read, `GITHUB_WRITE_TOKEN` with Issues read and write); if both kinds are set, the app wins.

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
```

Run setup from one place at a time: not from a laptop while the workflow runs.

setup refuses, and changes nothing, when it finds something it did not create where it expects its own resources: an Access app, D1 database or bucket with the expected name but no id in `hub.json`, extra Access policies or rules, or a hostname another Worker or DNS record already uses.
