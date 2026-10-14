-- The organisation's GitHub App, created from the hub's admin page (#56): at
-- most one row. The private key is sealed with the hub key (SPECREVIEW_KEY).
CREATE TABLE github_app (
  one INTEGER PRIMARY KEY CHECK (one = 1),
  app_id INTEGER NOT NULL,
  slug TEXT NOT NULL,
  sealed_key TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- The state an admin's browser carries through GitHub's app-manifest flow:
-- single use, an hour long, tied to the admin who started it.
CREATE TABLE admin_states (
  state TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
