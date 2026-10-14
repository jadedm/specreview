export type Env = {
  DB: D1Database;
  // JSON of specreview.config.json; see config.ts.
  SPECREVIEW_CONFIG: string;
  // Published sites (#5 writes, the hub reads); layout in store.ts. Unset
  // only before `specreview init` (#7) creates the bucket.
  SITES?: R2Bucket;
  // The GitHub App (#6): its id and its private key (PKCS#1 as GitHub
  // downloads it, or PKCS#8). Secrets. When both are set they replace the
  // personal tokens.
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  // The hub key: 32 random bytes in base64 that seal what the hub keeps in D1
  // (the GitHub App created from the admin page, #56). deploy sets it once.
  SPECREVIEW_KEY?: string;
  // Personal tokens, for a hub without the app: read is Issues read, write is
  // Issues read and write. Secrets, set by a person.
  GITHUB_READ_TOKEN?: string;
  GITHUB_WRITE_TOKEN?: string;
};
