-- Tickets GitHub answered "not found" for (#176), kept as long as a found
-- ticket's copy in ticket_cache, so a page linking a missing ticket does not
-- ask GitHub again on every read. Its own table: ticket_cache holds only
-- issues, as every version of the Worker reads it.
CREATE TABLE ticket_missing (
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (repo, number)
);
