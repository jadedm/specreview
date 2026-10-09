// src/cli.ts
import { appendFileSync } from "node:fs";

// src/publish.ts
import { existsSync, openAsBlob, readdirSync } from "node:fs";
import path from "node:path";
var PublishError = class extends Error {
};
var hubOrigin = (hub) => {
  const url = (() => {
    try {
      return new URL(hub);
    } catch {
      return null;
    }
  })();
  const local = url !== null && url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname);
  const ok = url !== null && (url.protocol === "https:" || local) && url.username === "" && url.password === "" && (url.pathname === "/" || url.pathname === "") && url.search === "" && url.hash === "";
  if (!ok)
    throw new PublishError(`hub must be an https origin such as https://docs.example.com, got ${JSON.stringify(hub)}`);
  return url.origin;
};
var REPO = /^[a-z0-9._-]{1,100}$/;
var actionsToken = async (audience, env2, fetchImpl) => {
  const url = env2.ACTIONS_ID_TOKEN_REQUEST_URL;
  const bearer = env2.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !bearer) {
    throw new PublishError("no OIDC token available: the publish job needs `permissions: id-token: write`");
  }
  const res = await fetchImpl(`${url}&audience=${encodeURIComponent(audience)}`, {
    headers: { authorization: `bearer ${bearer}` },
    redirect: "error"
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || typeof body?.value !== "string")
    throw new PublishError(`the OIDC token request failed (${res.status})`);
  return body.value;
};
var filesOf = (out) => ["site", "history"].flatMap((top) => {
  const dir = path.join(out, top);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true }).filter((d) => d.isFile()).map((d) => {
    const file = path.join(d.parentPath, d.name);
    return { name: `${top}/${path.relative(dir, file).split(path.sep).join("/")}`, file };
  }).sort((a, b) => a.name.localeCompare(b.name));
});
var ATTEMPTS = 3;
var publishBuild = async ({
  hub,
  repo,
  out,
  env: env2,
  fetch: fetchImpl = fetch,
  wait
}) => {
  const origin = hubOrigin(hub);
  if (!REPO.test(repo))
    throw new PublishError(`repo must be the repository's lowercase name, got ${JSON.stringify(repo)}`);
  const files = filesOf(out);
  if (!files.some((f) => f.name === "site/manifest.json"))
    throw new PublishError(`${out}/site/manifest.json is missing: run the build first`);
  const pause = wait ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let last = "";
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const form = new FormData();
    for (const f of files) form.append(f.name, await openAsBlob(f.file), path.basename(f.file));
    const token = await actionsToken(origin, env2, fetchImpl).catch((e) => {
      if (e instanceof PublishError && e.message.includes("id-token: write")) throw e;
      last = e instanceof Error ? e.message : String(e);
      return null;
    });
    if (token === null) {
      if (attempt === ATTEMPTS) break;
      await pause(2e3 * attempt);
      continue;
    }
    const res = await fetchImpl(`${origin}/_publish/${repo}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: form,
      redirect: "error"
    }).catch((e) => {
      last = `network error: ${e instanceof Error ? e.message : String(e)}`;
      return null;
    });
    const body = res ? await res.json().catch(() => null) : null;
    if (res?.ok && typeof body?.version === "string") return { version: body.version };
    if (res?.status === 409 && body?.error?.code === "SUPERSEDED") return { superseded: true };
    if (res) last = `${res.status} ${body?.error?.code ?? ""} ${body?.error?.message ?? ""}`.trim();
    const retryable = res === null || res.status >= 500;
    if (!retryable || attempt === ATTEMPTS) break;
    await pause(2e3 * attempt);
  }
  throw new PublishError(`publishing to ${origin} failed: ${last}`);
};

// src/cli.ts
var env = process.env;
publishBuild({ hub: env.INPUT_HUB ?? "", repo: env.INPUT_REPO ?? "", out: env.INPUT_OUT || ".specreview", env }).then(
  (result) => {
    const line = "version" in result ? `published ${result.version}` : "a later run has already published; nothing to do";
    process.stdout.write(`${line}
`);
    if ("version" in result && env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `version=${result.version}
`);
  },
  (err) => {
    console.error(err instanceof PublishError ? err.message : "publishing failed");
    process.exit(1);
  }
);
