-- Ticket repos the hub has set labels in (#155), so the cron can clear our
-- labels from a repo after every site stops listing it. A row is deleted once
-- that clearing succeeds, unless a label was set after the clearing began.
-- failing_since is when clearing a repo no site lists began to fail; after a
-- week of failures the repo is forgotten and its labels are left for a person.
CREATE TABLE label_repos (
  repo TEXT PRIMARY KEY,
  labelled_at INTEGER NOT NULL,
  failing_since INTEGER
);
