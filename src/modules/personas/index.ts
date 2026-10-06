/**
 * Personas module — one persona per group, negotiated with the owner in DM.
 *
 *   1. The bot lands in a group (join event, a group missing from the last
 *      sync, or a mention in a group nobody wired). Nothing is said there.
 *   2. The owner gets a DM: which persona? They answer with the name of a
 *      persona file, with free text (`Name, description`), or `ignore`.
 *   3. The owner gets the intro to proofread and answers `ok` (skipped when
 *      the answer carried `direct`).
 *   4. The group is wired (see wire-group.ts) and the persona introduces
 *      itself, once: `messaging_groups.introduced_at` remembers it.
 *
 * While a setup is pending, the owner's next DM is read as the answer and
 * does not reach the agent wired to that DM. Messages injected through the
 * CLI admin transport (`cli:admin`) are never captured.
 */
import os from 'os';
import path from 'path';

import { getChannelAdapter } from '../../channels/channel-registry.js';
import type { InboundEvent } from '../../channels/adapter.js';
import {
  createMessagingGroup,
  getMessagingGroup,
  getMessagingGroupWithAgentCount,
  setMessagingGroupDeniedAt,
  updateMessagingGroup,
} from '../../db/messaging-groups.js';
import { readEnvFile } from '../../env.js';
import { setGroupEventHandlers } from '../../group-events.js';
import { log } from '../../log.js';
import { setInboundInterceptor } from '../../router.js';
import type { MessagingGroup } from '../../types.js';
import { pickApprovalDelivery, pickApprover } from '../approvals/primitive.js';
import { isOwner } from '../permissions/db/user-roles.js';
import {
  countSeenGroups,
  createPendingPersonaSetup,
  deletePendingPersonaSetup,
  getIntroducedAt,
  getOldestPendingPersonaSetup,
  getPendingPersonaSetup,
  markGroupSeen,
  setIntroducedAt,
  updatePendingPersonaSetup,
  type PendingPersonaSetup,
} from './db.js';
import { listPersonaFiles, loadPersonaFile, parseOwnerReply, personaFromText, type PersonaDraft } from './persona.js';
import { wireGroup } from './wire-group.js';

const env = readEnvFile(['PERSONAS_DIR', 'PERSONA_MODEL']);
const PERSONAS_DIR =
  process.env.PERSONAS_DIR || env.PERSONAS_DIR || path.join(os.homedir(), 'projects', 'admin', 'iann-personas');
// The host default (Haiku) holds a persona poorly in a group.
const PERSONA_MODEL = process.env.PERSONA_MODEL || env.PERSONA_MODEL || 'anthropic/claude-sonnet-5';

function groupLabel(mg: MessagingGroup): string {
  return mg.name ?? mg.platform_id;
}

/** DM the owner. Returns false when nobody is reachable or the platform gave no message id. */
async function tellOwner(channelType: string, text: string): Promise<boolean> {
  const delivery = await pickApprovalDelivery(pickApprover(null), channelType);
  if (!delivery) {
    log.warn('Persona setup: no owner reachable by DM', { channelType });
    return false;
  }
  const adapter = getChannelAdapter(delivery.messagingGroup.channel_type);
  if (!adapter) return false;
  try {
    const id = await adapter.deliver(delivery.messagingGroup.platform_id, null, { kind: 'chat', content: { text } });
    return Boolean(id);
  } catch (err) {
    log.error('Persona setup: DM to owner failed', { err });
    return false;
  }
}

/**
 * Ask the owner which persona to wear in this group. No-op when the group
 * is already wired, was declined, or is already being set up.
 */
export async function startPersonaSetup(channelType: string, platformId: string, name?: string): Promise<void> {
  const found = getMessagingGroupWithAgentCount(channelType, platformId);
  if (found && (found.agentCount > 0 || found.mg.denied_at)) return;

  let mg = found?.mg;
  if (!mg) {
    mg = {
      id: `mg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      channel_type: channelType,
      platform_id: platformId,
      name: name ?? null,
      is_group: 1,
      unknown_sender_policy: 'public',
      denied_at: null,
      created_at: new Date().toISOString(),
    };
    createMessagingGroup(mg);
  } else if (name && mg.name !== name) {
    updateMessagingGroup(mg.id, { name });
    mg = { ...mg, name };
  }
  if (getPendingPersonaSetup(mg.id)) return;

  createPendingPersonaSetup(mg.id);
  const available = listPersonaFiles(PERSONAS_DIR);
  const asked = await tellOwner(
    channelType,
    [
      `Je suis dans le groupe **${groupLabel(mg)}** sans personnalité. Laquelle je prends ?`,
      '',
      available.length > 0
        ? `• une persona existante : ${available.join(', ')}`
        : '• (aucune persona enregistrée pour le moment)',
      '• un texte libre : « Nom, description »',
      '• « ignore » pour que je reste muet dans ce groupe',
      '',
      'Options, à la fin : « , strict » (seuls les membres déclarés sont entendus), « , direct » (présentation sans relecture).',
    ].join('\n'),
  );
  if (!asked) {
    // Nobody was asked: drop the row so the next trigger can try again.
    deletePendingPersonaSetup(mg.id);
    return;
  }
  log.info('Persona setup started', { messagingGroupId: mg.id, platformId, name: mg.name });
}

async function previewForOwner(mg: MessagingGroup, draft: PersonaDraft): Promise<void> {
  const wake = [draft.name, ...draft.aliases].map((n) => `« ${n} »`).join(', ');
  await tellOwner(
    mg.channel_type,
    [
      `Persona **${draft.name}** pour **${groupLabel(mg)}**. Réveil : ${wake}, mention @ ou réponse à un de ses messages.`,
      'Présentation prévue :',
      '',
      draft.intro,
      '',
      '« ok » pour publier, « ignore » pour annuler, ou envoie un autre texte de présentation.',
    ].join('\n'),
  );
}

async function cancelSetup(mg: MessagingGroup): Promise<void> {
  setMessagingGroupDeniedAt(mg.id, new Date().toISOString());
  deletePendingPersonaSetup(mg.id);
  await tellOwner(mg.channel_type, `Compris, je reste muet dans **${groupLabel(mg)}**.`);
}

async function finalizeSetup(mg: MessagingGroup, draft: PersonaDraft): Promise<void> {
  const label = groupLabel(mg);
  const adapter = getChannelAdapter(mg.channel_type);
  if (!adapter) return;

  // Keep the draft: every exit below that is not a success waits for « ok ».
  updatePendingPersonaSetup(mg.id, 'awaiting_ok', draft);

  // A send to a group the bot has left returns nothing and looks delivered
  // in the log. Check before wiring anything.
  if (adapter.isGroupMember && !(await adapter.isGroupMember(mg.platform_id))) {
    await tellOwner(mg.channel_type, `Je ne suis pas membre de **${label}**. Rajoute-moi, puis réponds « ok ».`);
    return;
  }

  wireGroup({ mg, draft, model: PERSONA_MODEL });

  if (getIntroducedAt(mg.id)) {
    deletePendingPersonaSetup(mg.id);
    await tellOwner(
      mg.channel_type,
      `**${draft.name}** est en ligne dans **${label}** (déjà présenté, pas de nouvelle présentation).`,
    );
    return;
  }

  let messageId: string | undefined;
  try {
    messageId = await adapter.deliver(mg.platform_id, null, { kind: 'chat', content: { text: draft.intro } });
  } catch (err) {
    log.error('Persona intro delivery threw', { messagingGroupId: mg.id, err });
  }
  if (!messageId) {
    await tellOwner(
      mg.channel_type,
      `**${draft.name}** est câblé dans **${label}**, mais WhatsApp n'a pas confirmé la présentation. ` +
        'Elle peut encore partir à la prochaine reconnexion : regarde le groupe avant de répondre « ok » pour la renvoyer.',
    );
    return;
  }

  setIntroducedAt(mg.id, new Date().toISOString());
  deletePendingPersonaSetup(mg.id);
  log.info('Persona introduced', { messagingGroupId: mg.id, persona: draft.name, platformMsgId: messageId });
  await tellOwner(mg.channel_type, `**${draft.name}** est en ligne dans **${label}** et s'est présenté.`);
}

/** Apply the owner's DM to the pending setup. */
export async function handleOwnerReply(pending: PendingPersonaSetup, text: string): Promise<void> {
  const mg = getMessagingGroup(pending.messaging_group_id);
  if (!mg) {
    deletePendingPersonaSetup(pending.messaging_group_id);
    return;
  }
  const reply = parseOwnerReply(text);
  if (reply.kind === 'ignore') return cancelSetup(mg);

  if (pending.stage === 'awaiting_ok' && pending.draft) {
    if (reply.kind === 'ok') return finalizeSetup(mg, pending.draft);
    // Anything else is a rewritten intro. Keep the persona file in step so
    // the agent repeats the same text when asked to introduce itself.
    const intro = text.trim();
    const draft: PersonaDraft = {
      ...pending.draft,
      intro,
      personaMd: pending.draft.personaMd.replace(pending.draft.intro, intro),
    };
    updatePendingPersonaSetup(mg.id, 'awaiting_ok', draft);
    return previewForOwner(mg, draft);
  }

  let base: Pick<PersonaDraft, 'name' | 'aliases' | 'personaMd' | 'intro'> | null = null;
  if (reply.kind === 'file') {
    base = loadPersonaFile(PERSONAS_DIR, reply.slug);
    if (!base) {
      const available = listPersonaFiles(PERSONAS_DIR);
      await tellOwner(
        mg.channel_type,
        `Pas de persona « ${reply.slug} » pour **${groupLabel(mg)}**. Disponibles : ${available.join(', ') || 'aucune'}. ` +
          'Sinon : « Nom, description ».',
      );
      return;
    }
  } else if (reply.kind === 'text') {
    base = personaFromText(reply.name, reply.description, groupLabel(mg));
  }
  if (!base || (reply.kind !== 'file' && reply.kind !== 'text')) {
    await tellOwner(
      mg.channel_type,
      `Pour **${groupLabel(mg)}** : donne un nom de persona, « Nom, description », ou « ignore ».`,
    );
    return;
  }

  const draft: PersonaDraft = {
    ...base,
    unknownSenderPolicy: reply.strict ? 'strict' : 'public',
    direct: reply.direct,
  };
  if (draft.direct) return finalizeSetup(mg, draft);
  updatePendingPersonaSetup(mg.id, 'awaiting_ok', draft);
  return previewForOwner(mg, draft);
}

function parseContent(raw: string): { text?: string; sender?: string; senderId?: string; isGroup?: boolean } {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Router hook. Returns true when the message belonged to the persona flow
 * and must not be routed any further.
 */
export async function interceptInbound(event: InboundEvent): Promise<boolean> {
  const content = parseContent(event.message.content);
  const isGroup = content.isGroup === true || event.platformId.endsWith('@g.us');

  if (isGroup) {
    // Addressed in a group nobody wired: ask the owner instead of offering
    // to plug the group into whichever agent comes first.
    if (event.message.isMention !== true) return false;
    const found = getMessagingGroupWithAgentCount(event.channelType, event.platformId);
    if (found && found.agentCount > 0) return false;
    await startPersonaSetup(event.channelType, event.platformId);
    return true;
  }

  const pending = getOldestPendingPersonaSetup();
  if (!pending) return false;
  const handle = content.senderId ?? content.sender;
  if (!handle) return false;
  const userId = handle.includes(':') ? handle : `${event.channelType}:${handle}`;
  // Only the owner writing from the platform itself: `cli:admin` is an owner
  // too, and the morning briefing goes through it.
  if (!userId.startsWith(`${event.channelType}:`) || !isOwner(userId)) return false;

  await handleOwnerReply(pending, content.text ?? '');
  return true;
}

/** The adapter saw the bot being added to a group. */
export async function handleGroupJoined(channelType: string, platformId: string, name?: string): Promise<void> {
  markGroupSeen(channelType, platformId);
  await startPersonaSetup(channelType, platformId, name);
}

/**
 * Full list of the groups the bot sits in. The first list ever seen is the
 * baseline and asks nothing; later, an unknown group is a missed join.
 */
export async function handleGroupsSynced(
  channelType: string,
  groups: Array<{ platformId: string; name?: string }>,
): Promise<void> {
  const baseline = countSeenGroups(channelType) === 0;
  for (const group of groups) {
    const isNew = markGroupSeen(channelType, group.platformId);
    if (isNew && !baseline) await startPersonaSetup(channelType, group.platformId, group.name);
  }
}

setInboundInterceptor(interceptInbound);
setGroupEventHandlers({ joined: handleGroupJoined, synced: handleGroupsSynced });
