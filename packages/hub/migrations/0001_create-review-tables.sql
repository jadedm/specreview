-- Comments, page status and caches for every site on the hub (#3).
-- `site` is the canonical lowercase `owner/repo` key; every row carries it.

CREATE TABLE threads (
  site TEXT NOT NULL,
  id TEXT NOT NULL,
  page TEXT NOT NULL,
  heading TEXT NOT NULL,
  quote TEXT NOT NULL,
  prefix TEXT NOT NULL DEFAULT '',
  suffix TEXT NOT NULL DEFAULT '',
  page_hash TEXT NOT NULL,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'resolved')),
  resolved_by TEXT,
  resolved_pr INTEGER,
  resolved_at TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (site, id)
);
CREATE INDEX threads_page_idx ON threads (site, page, created_at);
CREATE INDEX threads_open_idx ON threads (site, page, author) WHERE state = 'open';

-- A reply belongs to a thread of the same site; the composite key makes a
-- reply pointing at another site's thread impossible.
CREATE TABLE replies (
  site TEXT NOT NULL,
  id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (site, id),
  FOREIGN KEY (site, thread_id) REFERENCES threads (site, id)
);
CREATE INDEX replies_thread_idx ON replies (site, thread_id, created_at);

-- A page with no row is pending at version 0.
CREATE TABLE page_status (
  site TEXT NOT NULL,
  page TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'in_review', 'ready')),
  version INTEGER NOT NULL,
  ready_hash TEXT,
  changed_by TEXT NOT NULL,
  changed_at TEXT NOT NULL,
  PRIMARY KEY (site, page)
);

CREATE TABLE status_history (
  site TEXT NOT NULL,
  id TEXT NOT NULL,
  page TEXT NOT NULL,
  status TEXT NOT NULL,
  version INTEGER NOT NULL,
  page_hash TEXT NOT NULL,
  changed_by TEXT NOT NULL,
  changed_at TEXT NOT NULL,
  PRIMARY KEY (site, id)
);
CREATE INDEX status_history_page_idx ON status_history (site, page, version);

-- Keyed by the ticket repo, not the site: two sites may link the same tickets.
CREATE TABLE ticket_cache (
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  data TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (repo, number)
);

CREATE TABLE write_log (
  site TEXT NOT NULL,
  email TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX write_log_idx ON write_log (site, email, at);
