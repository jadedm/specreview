export type Env = {
  DB: D1Database;
  // JSON of specreview.config.json; see config.ts.
  SPECREVIEW_CONFIG: string;
  // Personal tokens until the GitHub App (#6): read is Issues read, write is
  // Issues read and write. Secrets, set by a person.
  GITHUB_READ_TOKEN?: string;
  GITHUB_WRITE_TOKEN?: string;
};
