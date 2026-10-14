-- Readers and approvers removed on the admin page (#12) whose removal the
-- deployed config may not show yet. The hub acts as if they were gone. A row
-- stays until the entry is added back: Worker isolates can briefly hold an
-- older config, so "deployed" is never a safe moment to forget it.
CREATE TABLE pending_removals (
  site TEXT NOT NULL,
  list TEXT NOT NULL CHECK (list IN ('readers', 'approvers')),
  entry TEXT NOT NULL,
  removed_by TEXT NOT NULL,
  removed_at INTEGER NOT NULL,
  PRIMARY KEY (site, list, entry)
);
