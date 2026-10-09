# Security policy

## Reporting a vulnerability

Report it privately through GitHub: open the repository's Security tab and choose "Report a vulnerability". Please do not open a public issue for a vulnerability.

Include what you found, how to reproduce it, and what an attacker could do with it. Fixes are worked on in a private security advisory.

## Supported versions

specreview has no releases yet. Fixes go to the `develop` branch.

## In scope

- The hub (`packages/hub`): bypassing Cloudflare Access or a role check; reading another site's or another reader's data; a reader learning another person's email or a ticket title; changing a page's status without being an approver; publishing to a site from anything other than its configured repository, workflow and branch, or publishing twice with one token; serving an old version the live build does not list; leaking the hub's GitHub tokens, or writing labels anywhere but a site's configured ticket repository.
- The site build (`packages/site`): docs content that runs code on the build machine, reads files outside the repo's docs folder, or gets script into the built site past the build's checks.
- The review UI in the browser (`packages/site/src/theme/review/`): comment text, author labels, ticket data or old page versions from the hub that end up running as script.
- The publish action (`packages/action`, `build/`, `publish/`): leaking the GitHub Actions OIDC token, or publishing a build other than the one the workflow made.

## Out of scope

- What script does once it is in one repo's built site, when it acts on another site of the same hub. Sites of one organisation share an origin by design, and every site is that organisation's own docs. Getting the script into the site in the first place is in scope.
- Weaknesses in how an organisation configures its own Cloudflare account or Access application.
- Anything that needs a hub's own secrets, its Cloudflare account, or admin access to a configured GitHub repository.
