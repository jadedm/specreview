import type { Env } from './env';
import { open, seal, SealError } from './seal';

// The organisation's GitHub App as the hub stores it (#56): one row, the
// private key sealed with the hub key.

const PURPOSE = 'github_app.private_key';

export type StoredApp = { appId: number; slug: string; createdBy: string; createdAt: number };
export type OpenedApp = StoredApp & { privateKey: string };
// What the hub finds: nothing, an app it can use, or one its key cannot open.
export type Found =
  { kind: 'none' } | { kind: 'app'; app: OpenedApp } | { kind: 'locked'; app: StoredApp; why: string };

type Row = { app_id: number; slug: string; sealed_key: string; created_by: string; created_at: number };

export const findApp = async (env: Env): Promise<Found> => {
  const row = await env.DB.prepare(
    'SELECT app_id, slug, sealed_key, created_by, created_at FROM github_app WHERE one = 1',
  ).first<Row>();
  if (!row) return { kind: 'none' };
  const app = { appId: row.app_id, slug: row.slug, createdBy: row.created_by, createdAt: row.created_at };
  return open(env.SPECREVIEW_KEY, PURPOSE, row.sealed_key).then(
    (privateKey): Found => ({ kind: 'app', app: { ...app, privateKey } }),
    (err: unknown): Found => {
      if (!(err instanceof SealError)) throw err;
      return { kind: 'locked', app, why: err.message };
    },
  );
};

// Inserts only when no app is stored: a second app never replaces the first.
export const saveApp = async (env: Env, app: OpenedApp) => {
  const sealed = await seal(env.SPECREVIEW_KEY, PURPOSE, app.privateKey);
  // RETURNING gives a row only when this statement inserted one.
  const inserted = await env.DB.prepare(
    'INSERT INTO github_app (one, app_id, slug, sealed_key, created_by, created_at) VALUES (1, ?, ?, ?, ?, ?) ON CONFLICT (one) DO NOTHING RETURNING one',
  )
    .bind(app.appId, app.slug, sealed, app.createdBy, app.createdAt)
    .first();
  return inserted !== null;
};

export const forgetApp = async (env: Env) => {
  await env.DB.prepare('DELETE FROM github_app WHERE one = 1').run();
};
