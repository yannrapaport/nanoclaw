/**
 * Wire one WhatsApp group to its own persona: agent group, group folder
 * (CLAUDE.local.md + container.json) and the messaging_group → agent wiring.
 *
 * This is what the per-group `scripts/wire-*.ts` did by hand. Idempotent:
 * running it again on the same group reinstalls the persona and updates the
 * engage pattern.
 */
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, GROUPS_DIR } from '../../config.js';
import { updateContainerConfig } from '../../container-config.js';
import { createAgentGroup, getAgentGroupByFolder, updateAgentGroup } from '../../db/agent-groups.js';
import {
  createMessagingGroupAgent,
  getMessagingGroupAgentByPair,
  updateMessagingGroup,
  updateMessagingGroupAgent,
} from '../../db/messaging-groups.js';
import { initGroupFilesystem } from '../../group-init.js';
import { log } from '../../log.js';
import type { AgentGroup, MessagingGroup } from '../../types.js';
import { buildEngagePattern, slugify, type PersonaDraft } from './persona.js';

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface WireGroupInput {
  mg: MessagingGroup;
  draft: PersonaDraft;
  /** Provider model id for this group's container; unset = host default. */
  model?: string;
}

export interface WireGroupResult {
  agentGroup: AgentGroup;
  folder: string;
  engagePattern: string;
}

export function wireGroup({ mg, draft, model }: WireGroupInput): WireGroupResult {
  const now = new Date().toISOString();
  // One folder per group, keyed on the platform id so two groups with the
  // same name never share a persona. Folder names are capped at 64 chars.
  const label =
    slugify(mg.name ?? '')
      .slice(0, 40)
      .replace(/-+$/, '') || 'group';
  const folder = `${mg.channel_type}_${label}-${slugify(mg.platform_id.split('@')[0]).slice(-6)}`;

  let agentGroup = getAgentGroupByFolder(folder);
  if (!agentGroup) {
    createAgentGroup({
      id: generateId('ag'),
      name: draft.name,
      folder,
      agent_provider: 'opencode',
      created_at: now,
    });
    agentGroup = getAgentGroupByFolder(folder)!;
  } else if (agentGroup.name !== draft.name) {
    updateAgentGroup(agentGroup.id, { name: draft.name });
    agentGroup = { ...agentGroup, name: draft.name };
  }

  initGroupFilesystem(agentGroup, { instructions: `# ${draft.name}` });
  fs.writeFileSync(path.join(GROUPS_DIR, folder, 'CLAUDE.local.md'), draft.personaMd);
  const agentGroupId = agentGroup.id;
  updateContainerConfig(folder, (config) => {
    config.provider = 'opencode';
    config.groupName = draft.name;
    config.assistantName = draft.name;
    config.agentGroupId = agentGroupId;
    if (model) config.model = model;
  });

  if (mg.unknown_sender_policy !== draft.unknownSenderPolicy) {
    updateMessagingGroup(mg.id, { unknown_sender_policy: draft.unknownSenderPolicy });
  }

  const engagePattern = buildEngagePattern([draft.name, ...draft.aliases], ASSISTANT_NAME);
  const existing = getMessagingGroupAgentByPair(mg.id, agentGroup.id);
  if (existing) {
    updateMessagingGroupAgent(existing.id, { engage_mode: 'pattern', engage_pattern: engagePattern });
  } else {
    createMessagingGroupAgent({
      id: generateId('mga'),
      messaging_group_id: mg.id,
      agent_group_id: agentGroup.id,
      engage_mode: 'pattern',
      engage_pattern: engagePattern,
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now,
    });
  }

  log.info('Group wired to persona', {
    messagingGroupId: mg.id,
    agentGroupId: agentGroup.id,
    persona: draft.name,
    folder,
    engagePattern,
  });
  return { agentGroup, folder, engagePattern };
}
