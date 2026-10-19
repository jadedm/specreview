-- Publish tokens already used (#5). A GitHub Actions OIDC token publishes at
-- most once: its jti is inserted before anything is written, and a second
-- use fails on the primary key.
CREATE TABLE publish_tokens (
  jti TEXT PRIMARY KEY,
  site TEXT NOT NULL,
  used_at INTEGER NOT NULL
);
