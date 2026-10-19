// #91: migration 0005 rebuilds pending_removals to allow the team list. Run
// on a real SQLite database (D1 is SQLite): rows written under 0004 survive,
// the new list is accepted, anything else is still refused.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

const dir = path.join(import.meta.dirname, '..', 'migrations');
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.sql'))
  .sort();
const apply = (db: DatabaseSync, upTo: string) => {
  for (const f of files.filter((f) => f <= upTo)) db.exec(readFileSync(path.join(dir, f), 'utf8'));
};
const insert = (db: DatabaseSync, list: string, entry: string) =>
  db
    .prepare('INSERT INTO pending_removals (site, list, entry, removed_by, removed_at) VALUES (?, ?, ?, ?, ?)')
    .run('acme/sidecar', list, entry, 'owner@acme.dev', 1);

describe('#91: migration 0005, pending removals for team members', () => {
  it('keeps every row written before it, then takes team and still refuses other lists', () => {
    const db = new DatabaseSync(':memory:');
    apply(db, '0004_create-pending-removals.sql');
    insert(db, 'readers', 'ana@partner.example');
    insert(db, 'approvers', 'pm@acme.dev');
    expect(() => insert(db, 'team', 'manish@ariai.example')).toThrow(/CHECK constraint/);
    db.exec(readFileSync(path.join(dir, '0005_pending-removals-team-list.sql'), 'utf8'));
    const rows = db.prepare('SELECT list, entry, removed_by, removed_at FROM pending_removals ORDER BY list').all();
    expect(rows).toEqual([
      { list: 'approvers', entry: 'pm@acme.dev', removed_by: 'owner@acme.dev', removed_at: 1 },
      { list: 'readers', entry: 'ana@partner.example', removed_by: 'owner@acme.dev', removed_at: 1 },
    ]);
    insert(db, 'team', 'manish@ariai.example');
    expect(() => insert(db, 'admins', 'x@acme.dev')).toThrow(/CHECK constraint/);
    expect(() => insert(db, 'team', 'manish@ariai.example')).toThrow(/UNIQUE|PRIMARY KEY/);
  });
});
