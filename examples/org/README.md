# An organisation's hub

The shape of the private repo an organisation keeps for its specreview hub. Copy this folder, replace the example values, and add `.specreview/` (the checkout `run.sh` makes) to `.gitignore`.

| File                     | Holds                                                                                  | Written by      |
| ------------------------ | -------------------------------------------------------------------------------------- | --------------- |
| `specreview.config.json` | sites, team domains, approvers, readers, admins; optional `brand` (name, logo file)    | you             |
| `hub.json`               | account id, hostname, Worker name, D1 database and R2 bucket names; the ids below them | you, then setup |
| `specreview.commit`      | the full specreview commit to run                                                      | you             |
| `run.sh`                 | checks out that commit, builds the hub, runs a command                                 | copied          |

In a new repo, `hub.json` starts without ids: leave out `database.id`, `bucket.created` and `access`. setup records each one as soon as it creates the resource, so a run that fails between creates resumes on the next run. If a create's answer is lost (a timeout), the resource exists without an id; setup then refuses it as not its own and says how to record it: its id in `hub.json`, or `bucket.created: true` for the bucket. The `hub.json` in this folder is a finished example with made-up ids; do not copy those.

## Cloudflare token

One API token, kept in a file and passed with `--token-file`; it is read at each call and never printed or stored. Permissions:

- Account: Account Settings Read; Access: Apps and Policies Edit; Access: Organizations, Identity Providers, and Groups Edit; D1 Edit; Workers R2 Storage Edit; Workers Scripts Edit.
- Zone (the hostname's zone): Zone Read; DNS Read; Workers Routes Edit.

Zero Trust must be enabled on the account first (dashboard: Zero Trust, then the Free plan).

## First deploy

```
./run.sh setup --token-file <file>             # reads only; prints what it would create
./run.sh setup --token-file <file> --apply     # creates it; commit hub.json
./run.sh deploy --token-file <file> --dry-run  # builds, calls nothing
./run.sh deploy --token-file <file>            # migrations, then the Worker on the hostname
./run.sh secret --token-file <file> --name GITHUB_APP_ID --value-file <file>
./run.sh secret --token-file <file> --name GITHUB_APP_PRIVATE_KEY --value-file <file>
```

The hub talks to GitHub as a GitHub App owned by the organisation: repository permissions Issues read and write and Metadata read, no webhook, installed on the ticket repos. Its id is on the app's settings page; the private key is the `.pem` file GitHub downloads, passed as is. The hub mints a token per ticket repo, with Issues read for reading tickets and Issues write for labels. A hub without the app can use two fine-grained personal tokens instead (`GITHUB_READ_TOKEN` with Issues read, `GITHUB_WRITE_TOKEN` with Issues read and write); if both kinds are set, the app wins. Run setup from one place at a time.

## Changes later

- The organisation's name and logo in each site's header: `"brand": { "name": "Acme", "logo": "logo.png" }` in `specreview.config.json`, the PNG or WebP (at most 256 KB) beside it in this folder, then `deploy`. Leave out `logo` for the name alone, or `brand` for neither. deploy keeps `hub.json` `brand` up to date; commit it after each deploy.

- Readers, approvers, admins or sites: edit `specreview.config.json`, run `setup --apply` (it brings the Access policy to exactly what the config says, removals included), then `deploy`.
- Upgrading: change `specreview.commit`, run `deploy`. Migrations only add, so the previous Worker keeps working on the newer schema.
- Rolling back the Worker: `npx wrangler rollback --name <worker>` from the checkout, with the token in `CLOUDFLARE_API_TOKEN`. Migrations are not rolled back.

setup refuses, and changes nothing, when it finds something it did not create where it expects its own resources: an Access app, D1 database or bucket with the expected name but no id in `hub.json`, extra Access policies or rules, or a hostname another Worker or DNS record already uses.
