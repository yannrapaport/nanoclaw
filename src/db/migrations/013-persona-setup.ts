/**
 * Per-group personas: the bot joins a group, asks the owner in DM which
 * persona to wear there, wires the group and introduces itself once.
 *
 * Three changes:
 *   1. `messaging_groups.introduced_at TEXT NULL` — set when the persona's
 *      intro was confirmed by the platform. The intro is never sent twice.
 *   2. `pending_persona_setups` — one row per group whose persona is being
 *      negotiated with the owner. PRIMARY KEY on `messaging_group_id` gives
 *      free dedup (same idea as `pending_channel_approvals`).
 *   3. `seen_groups` — groups the bot is known to sit in. The first sync
 *      records the baseline without asking anything; a group that shows up
 *      later is a join the adapter missed while offline.
 */
import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration013: Migration = {
  version: 13,
  name: 'persona-setup',
  up: (db: Database.Database) => {
    const cols = db.prepare("PRAGMA table_info('messaging_groups')").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'introduced_at')) {
      db.exec(`ALTER TABLE messaging_groups ADD COLUMN introduced_at TEXT`);
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS pending_persona_setups (
        messaging_group_id   TEXT PRIMARY KEY REFERENCES messaging_groups(id),
        stage                TEXT NOT NULL,      -- 'awaiting_persona' | 'awaiting_ok'
        draft                TEXT,               -- JSON PersonaDraft, set once the owner answered
        created_at           TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS seen_groups (
        channel_type         TEXT NOT NULL,
        platform_id          TEXT NOT NULL,
        first_seen           TEXT NOT NULL,
        PRIMARY KEY (channel_type, platform_id)
      );
    `);
  },
};
