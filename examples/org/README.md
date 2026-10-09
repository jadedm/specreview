# An organisation's hub

The shape of the private repo an organisation keeps for its specreview hub. Copy this folder, replace the example values, and add `.specreview/` (the checkout `run.sh` makes) to `.gitignore`.

| File                     | Holds                                                                                  | Written by      |
| ------------------------ | -------------------------------------------------------------------------------------- | --------------- |
| `specreview.config.json` | sites, team domains, approvers, readers, admins                                        | you             |
| `hub.json`               | account id, hostname, Worker name, D1 database and R2 bucket names; the ids below them | you, then setup |
| `specreview.commit`      | the full specreview commit to run                                                      | you             |
| `run.sh`                 | checks out that commit, builds the hub, runs a command                                 | copied          |

In a new repo, `hub.json` starts without ids: leave out `database.id`, `bucket.created` and `access`. setup records each one as soon as it creates the resource, so a run that fails between creates resumes on the next run. If a create's answer is lost (a timeout), the resource exists without an id; setup then refuses it as not its own, and you add its id to `hub.json` yourself. The `hub.json` in this folder is a finished example with made-up ids; do not copy those.

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
./run.sh secret --token-file <file> --name GITHUB_READ_TOKEN --value-file <file>
./run.sh secret --token-file <file> --name GITHUB_WRITE_TOKEN --value-file <file>
```

The GitHub tokens are fine-grained tokens on the ticket repos: Issues read, and Issues read and write. Run setup from one place at a time.

## Changes later

- Readers, approvers, admins or sites: edit `specreview.config.json`, run `setup --apply` (it brings the Access policy to exactly what the config says, removals included), then `deploy`.
- Upgrading: change `specreview.commit`, run `deploy`. Migrations only add, so the previous Worker keeps working on the newer schema.
- Rolling back the Worker: `npx wrangler rollback --name <worker>` from the checkout, with the token in `CLOUDFLARE_API_TOKEN`. Migrations are not rolled back.

setup refuses, and changes nothing, when it finds something it did not create where it expects its own resources: an Access app, D1 database or bucket with the expected name but no id in `hub.json`, extra Access policies or rules, or a hostname another Worker or DNS record already uses.
