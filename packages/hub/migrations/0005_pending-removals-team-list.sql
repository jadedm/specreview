-- #91: a removal may also be of a person named in a site's team. SQLite
-- cannot change a CHECK constraint in place, so the table is rebuilt with
-- the same columns and key; every row is kept, and a Worker on the older
-- code reads and writes it as before.
CREATE TABLE pending_removals_next (
  site TEXT NOT NULL,
  list TEXT NOT NULL CHECK (list IN ('readers', 'approvers', 'team')),
  entry TEXT NOT NULL,
  removed_by TEXT NOT NULL,
  removed_at INTEGER NOT NULL,
  PRIMARY KEY (site, list, entry)
);
INSERT INTO pending_removals_next (site, list, entry, removed_by, removed_at)
  SELECT site, list, entry, removed_by, removed_at FROM pending_removals;
DROP TABLE pending_removals;
ALTER TABLE pending_removals_next RENAME TO pending_removals;
