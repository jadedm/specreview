// Entry for the publish action (publish/action.yml): inputs arrive as
// INPUT_HUB, INPUT_REPO and INPUT_OUT; the version goes to GITHUB_OUTPUT.
import { appendFileSync } from 'node:fs';
import { inert, publishBuild, PublishError } from './publish.js';

const env = process.env;
publishBuild({ hub: env.INPUT_HUB ?? '', repo: env.INPUT_REPO ?? '', out: env.INPUT_OUT || '.specreview', env }).then(
  (result) => {
    const line =
      'version' in result ? `published ${result.version}` : 'a later run has already published; nothing to do';
    process.stdout.write(`${line}\n`);
    if ('version' in result && env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `version=${result.version}\n`);
  },
  (err: unknown) => {
    // Its parts are inert already; the inputs it may name are made so here.
    console.error(err instanceof PublishError ? inert(err.message, 2000) : 'publishing failed');
    process.exit(1);
  },
);
