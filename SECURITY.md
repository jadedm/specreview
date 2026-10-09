# Security policy

## Reporting a vulnerability

Report it privately through GitHub: open the repository's Security tab and choose "Report a vulnerability". Please do not open a public issue for a vulnerability.

Include what you found, how to reproduce it, and what an attacker could do with it.

## Trust model

Anyone who can push to a site's configured branch is trusted with the whole hub origin. The hub checks who published a build and that the build is complete, not what its pages contain, and it serves the content security policy the build's manifest declares. That person can change the workflow and publish any HTML, and script in one site runs with the viewer's sign-in on every site of the same hub. The site build's checks exist so that Markdown from a reviewed pull request cannot carry code.

## Supported versions

specreview has no releases yet. Fixes go to the `develop` branch.

## In scope

- The hub (`packages/hub`): bypassing Cloudflare Access or a role check; reading another site's or another reader's data; a reader learning another person's email or a ticket title; changing a page's status without being an approver; publishing to a site from anything other than a push to its configured repository, workflow, branch and (when set) GitHub environment, or publishing twice with one token; serving an old version the live build does not list; leaking the hub's GitHub tokens, or writing labels anywhere but a site's configured ticket repository.
- The site build (`packages/site`): Markdown or other docs content that runs code on the build machine, reads files outside the repo's docs folder, or gets script into the built site past the build's checks.
- The review UI in the browser (`packages/site/src/theme/review/`): comment text, author labels, ticket data or old page versions from the hub that end up running as script.
- The publish action (`packages/action`, `build/`, `publish/`): leaking the GitHub Actions OIDC token, or publishing a build other than the one the workflow made.

## Out of scope

- What a person trusted under the trust model above can do, including publishing a build that skips the site build, and what script does once it is in one site when it acts on another site of the same hub. Getting script into a site through docs content alone is in scope.
- Weaknesses in how an organisation configures its own Cloudflare account or Access application, including the Access bypass for `/_publish/*` that publishing needs.
- Denial of service by volume, against the hub or `/_publish/` (a build may be up to 25 MiB and 5000 files).
- Anything that needs a hub's own secrets, its Cloudflare account, or admin access to a configured GitHub repository.
