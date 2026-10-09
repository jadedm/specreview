# specreview

Review specs where they are rendered: comments, sign-off and ticket status for docs-as-code, self-hosted on Cloudflare. Work in progress; see issue #1.

## Licence

- `packages/hub`, the Cloudflare Worker that serves sites and runs review, is licensed under the GNU Affero General Public License v3.0 only (`packages/hub/LICENSE`). If you run a modified hub as a service, you must offer its source to the people who use it.
- Everything else (the publish action, the CLI, the site build and the shared package) is MIT (`LICENSE`), so product repositories can use them freely.
