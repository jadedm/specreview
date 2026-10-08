export type Env = {
  DB: D1Database;
  // JSON of specreview.config.json; see config.ts.
  SPECREVIEW_CONFIG: string;
  // Published sites (#5 writes, the hub reads); layout in store.ts. Unset
  // only before `specreview init` (#7) creates the bucket.
  SITES?: R2Bucket;
  // Personal tokens until the GitHub App (#6): read is Issues read, write is
  // Issues read and write. Secrets, set by a person.
  GITHUB_READ_TOKEN?: string;
  GITHUB_WRITE_TOKEN?: string;
};
