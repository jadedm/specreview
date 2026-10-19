# Security policy

## Reporting a vulnerability

Report it privately through GitHub: open the repository's Security tab and choose "Report a vulnerability". Please do not open a public issue for a vulnerability.

Include what you found, how to reproduce it, and what an attacker could do with it.

## Trust model

Anyone who can push to a site's configured branch is trusted with the whole hub origin. The hub checks who published a build and that the build is complete, not what its pages contain, and it serves the content security policy the build's manifest declares. That person can change the workflow and publish any HTML, and script in one site runs with the viewer's sign-in on every site of the same hub. The site build's checks exist so that Markdown from a reviewed pull request cannot carry code.

The config's admins are trusted with the hub: the admin page lets them create and forget the organisation's GitHub App, add sites, and change who reads and approves, through commits and pull requests the app makes. The admin page is served only on its own hostname, behind its own Access application for the admins, so the docs sites' origin cannot read it or post to it.

Whoever can write to an organisation's hub config repo can read its Cloudflare token (an Actions secret reaches workflows on any branch) and change what the hub deploys; the template's README says to give that access only to the hub's administrators. That token can change every Access application, D1 database, R2 bucket and Worker on the Cloudflare account, not only the hub's, because Cloudflare cannot scope those permissions to one resource; a separate account for the hub keeps that reach to the hub. Whoever holds the hub's GitHub App private key (a hub secret, or sealed in the hub's database) can reach that token too, two ways: the app writes to the config repo's default branch (the readers and approvers form commits there) and the apply workflow runs the repo's own scripts on every push to `main`; and its Workflows permission lets it add a workflow on another branch, which a repository secret also reaches. Dropping the Workflows permission alone would leave the first. The template's README lists what GitHub's plans add for a private repository: an environment limited to `main` (Team) closes the second; only required reviewers on it (Enterprise Cloud) hold the first, and only as well as each reviewer reads what is on `main`.

A public site's pages are served with `public, max-age=60`, so after a site is made private, caches may serve its pages for up to a minute.

Readers see the comments on any page they may read, including the bodies of threads whose quoted text has since changed (the quote itself is hidden from them) and threads resolved before they were given access.

## Supported versions

specreview has no releases yet. Fixes go to the `develop` branch; a hub runs the commit its config repo pins.

## In scope

- The hub (`packages/hub`): bypassing Cloudflare Access or a role check; reading another site's or another reader's data; a reader learning another person's email or a ticket title; changing a page's status without being an approver; publishing to a site from anything other than a push to its configured repository, workflow, branch and (when set) GitHub environment, or publishing twice with one token; serving an old version the live build does not list; leaking the hub's GitHub tokens, or writing labels anywhere but a site's configured ticket repository.
- The admin page (on its own hostname): a non-admin reaching it or making it act; a docs site, or any other origin, reading it or changing anything; getting the GitHub App's private key out of the hub, or using a stored app owned by another account; the add-site and readers-and-approvers forms writing anything but the change asked for, or a removal not taking effect at once or being undone by anyone but an admin.
- Public sites: a private site, or any `_api` or `_history` path, readable without signing in.
- The site build (`packages/site`): Markdown or other docs content that runs code on the build machine, reads files outside the repo's docs folder, or gets script into the built site past the build's checks.
- The review UI in the browser (`packages/site/src/theme/review/`): comment text, author labels, ticket data or old page versions from the hub that end up running as script.
- The publish action (`packages/action`, `build/`, `publish/`): leaking the GitHub Actions OIDC token, or publishing a build other than the one the workflow made.
- Setting up and running a hub (`packages/hub/deploy/`, `examples/org/`): setup or deploy opening the hub to people the config does not list, including through the Access policies, apps and paths setup itself writes and keeps in sync; the apply workflow running for anything but `main`, or leaking the Cloudflare token; `workflow-token` printing or leaking the token it creates, or giving it more than its documented permissions.
- CI and the contribution path: a fork's pull request reaching a secret, writing to the repository, or poisoning what a later run on `develop` or `main` uses.

## Out of scope

- What a person trusted under the trust model above can do, including publishing a build that skips the site build, and what script does once it is in one site when it acts on another site of the same hub. Getting script into a site through docs content alone is in scope.
- Weaknesses in how an organisation configures its own Cloudflare account or Access application, including the Access bypass for `/_publish/*` that publishing needs.
- Denial of service by volume, against the hub or `/_publish/` (a build may be up to 25 MiB and 5000 files).
- Anything that needs a hub's own secrets, its Cloudflare account, or admin access to a configured GitHub repository.
