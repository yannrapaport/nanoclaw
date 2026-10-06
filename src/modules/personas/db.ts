/**
 * State for the per-group persona flow (migration 013).
 */
import { getDb } from '../../db/connection.js';
import type { PersonaDraft } from './persona.js';

export type PersonaSetupStage = 'awaiting_persona' | 'awaiting_ok';

export interface PendingPersonaSetup {
  messaging_group_id: string;
  stage: PersonaSetupStage;
  draft: PersonaDraft | null;
  created_at: string;
}

interface Row {
  messaging_group_id: string;
  stage: PersonaSetupStage;
  draft: string | null;
  created_at: string;
}

function fromRow(row: Row): PendingPersonaSetup {
  return { ...row, draft: row.draft ? (JSON.parse(row.draft) as PersonaDraft) : null };
}

export function createPendingPersonaSetup(messagingGroupId: string): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO pending_persona_setups (messaging_group_id, stage, draft, created_at)
       VALUES (?, 'awaiting_persona', NULL, ?)`,
    )
    .run(messagingGroupId, new Date().toISOString());
}

export function getPendingPersonaSetup(messagingGroupId: string): PendingPersonaSetup | undefined {
  const row = getDb()
    .prepare('SELECT * FROM pending_persona_setups WHERE messaging_group_id = ?')
    .get(messagingGroupId) as Row | undefined;
  return row ? fromRow(row) : undefined;
}

/** The setup the owner's next DM answers: oldest first, one group at a time. */
export function getOldestPendingPersonaSetup(): PendingPersonaSetup | undefined {
  const row = getDb().prepare('SELECT * FROM pending_persona_setups ORDER BY created_at, rowid LIMIT 1').get() as
    | Row
    | undefined;
  return row ? fromRow(row) : undefined;
}

export function updatePendingPersonaSetup(
  messagingGroupId: string,
  stage: PersonaSetupStage,
  draft: PersonaDraft | null,
): void {
  getDb()
    .prepare('UPDATE pending_persona_setups SET stage = ?, draft = ? WHERE messaging_group_id = ?')
    .run(stage, draft ? JSON.stringify(draft) : null, messagingGroupId);
}

export function deletePendingPersonaSetup(messagingGroupId: string): void {
  getDb().prepare('DELETE FROM pending_persona_setups WHERE messaging_group_id = ?').run(messagingGroupId);
}

export function setIntroducedAt(messagingGroupId: string, at: string): void {
  getDb().prepare('UPDATE messaging_groups SET introduced_at = ? WHERE id = ?').run(at, messagingGroupId);
}

export function getIntroducedAt(messagingGroupId: string): string | null {
  const row = getDb().prepare('SELECT introduced_at FROM messaging_groups WHERE id = ?').get(messagingGroupId) as
    | { introduced_at: string | null }
    | undefined;
  return row?.introduced_at ?? null;
}

export function countSeenGroups(channelType: string): number {
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM seen_groups WHERE channel_type = ?').get(channelType) as {
    n: number;
  };
  return row.n;
}

/** Record a group; returns true when it was not known before. */
export function markGroupSeen(channelType: string, platformId: string): boolean {
  const res = getDb()
    .prepare('INSERT OR IGNORE INTO seen_groups (channel_type, platform_id, first_seen) VALUES (?, ?, ?)')
    .run(channelType, platformId, new Date().toISOString());
  return res.changes > 0;
}
