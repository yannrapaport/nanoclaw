/**
 * Integration tests for the per-group persona flow.
 *
 * Covers:
 *  - Join: the owner is asked in DM, nothing is said in the group
 *  - Persona file + « ok »: group wired, intro posted once, marker set
 *  - Free text + « direct »: wired and introduced with no preview
 *  - « ignore »: group declined, never asked again
 *  - Capture: only the owner's own DM is read as the answer — not the CLI
 *    admin transport (morning briefing), not another sender
 *  - Bot not in the group: nothing wired, nothing marked
 *  - Intro not confirmed by the platform: not marked as introduced
 *  - Sync: the first list is a baseline, a later unknown group is a join
 *  - Router: a mention wakes a name-pattern persona; a mention in an unwired
 *    group starts a setup instead of the channel-approval card
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DIR, PERSONAS_DIR } = vi.hoisted(() => {
  const TEST_DIR = '/tmp/nanoclaw-test-personas';
  const PERSONAS_DIR = `${TEST_DIR}/personas`;
  process.env.PERSONAS_DIR = PERSONAS_DIR;
  process.env.PERSONA_MODEL = 'test/model';
  return { TEST_DIR, PERSONAS_DIR };
});

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return {
    ...actual,
    DATA_DIR: `${TEST_DIR}/data`,
    GROUPS_DIR: `${TEST_DIR}/groups`,
    ASSISTANT_NAME: 'IAnn',
  };
});

const wakeContainer = vi.fn().mockResolvedValue(undefined);
vi.mock('../../container-runner.js', () => ({
  wakeContainer: (...args: unknown[]) => wakeContainer(...args),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

const deliver = vi.fn();
const isGroupMember = vi.fn();
vi.mock('../../channels/channel-registry.js', async () => {
  const actual = await vi.importActual('../../channels/channel-registry.js');
  return {
    ...actual,
    getChannelAdapter: () => ({
      name: 'whatsapp',
      channelType: 'whatsapp',
      supportsThreads: false,
      isConnected: () => true,
      deliver,
      isGroupMember,
    }),
  };
});

vi.mock('../permissions/user-dm.js', () => ({
  ensureUserDm: vi.fn(async (userId: string) => {
    const { getDb } = await import('../../db/connection.js');
    return getDb()
      .prepare(
        `SELECT mg.* FROM messaging_groups mg
           JOIN user_dms ud ON ud.messaging_group_id = mg.id
          WHERE ud.user_id = ?`,
      )
      .get(userId);
  }),
}));

import { closeDb, getDb, initTestDb, runMigrations } from '../../db/index.js';
import {
  createMessagingGroup,
  getMessagingGroupAgents,
  getMessagingGroupByPlatform,
} from '../../db/messaging-groups.js';
import { routeInbound } from '../../router.js';
import { grantRole } from '../permissions/db/user-roles.js';
import { upsertUser } from '../permissions/db/users.js';
import { getIntroducedAt, getPendingPersonaSetup } from './db.js';
import { handleGroupJoined, handleGroupsSynced, interceptInbound } from './index.js';

const OWNER_JID = '33600000000@s.whatsapp.net';
const GROUP_JID = '120363000000000001@g.us';
const INTRO = 'Salut la compagnie, c’est Raymond.';

const now = () => new Date().toISOString();

function dm(text: string, sender = OWNER_JID, extra: Record<string, unknown> = {}) {
  return {
    channelType: 'whatsapp',
    platformId: OWNER_JID,
    threadId: null,
    message: {
      id: `msg-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat' as const,
      content: JSON.stringify({ text, sender, isGroup: false, ...extra }),
      timestamp: now(),
    },
  };
}

function groupMessage(text: string, isMention: boolean, platformId = GROUP_JID) {
  return {
    channelType: 'whatsapp',
    platformId,
    threadId: null,
    message: {
      id: `msg-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat' as const,
      content: JSON.stringify({ text, sender: '33611111111@s.whatsapp.net', isGroup: true }),
      timestamp: now(),
      isMention,
    },
  };
}

const sentTo = (platformId: string) => deliver.mock.calls.filter((c) => c[0] === platformId);
const textOf = (call: unknown[]) => (call[2] as { content: { text: string } }).content.text;
const groupMg = () => getMessagingGroupByPlatform('whatsapp', GROUP_JID)!;

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(PERSONAS_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(PERSONAS_DIR, 'raymond.md'),
    [
      '# Raymond',
      '',
      'Alias : Poupou',
      '',
      '## Ta présentation',
      '',
      'Envoie exactement ce texte :',
      '',
      INTRO,
      '',
    ].join('\n'),
  );
  runMigrations(initTestDb());

  upsertUser({ id: `whatsapp:${OWNER_JID}`, kind: 'whatsapp', display_name: 'Owner', created_at: now() });
  grantRole({
    user_id: `whatsapp:${OWNER_JID}`,
    role: 'owner',
    agent_group_id: null,
    granted_by: null,
    granted_at: now(),
  });
  upsertUser({ id: 'cli:admin', kind: 'cli', display_name: 'CLI', created_at: now() });
  grantRole({ user_id: 'cli:admin', role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });
  createMessagingGroup({
    id: 'mg-dm-owner',
    channel_type: 'whatsapp',
    platform_id: OWNER_JID,
    name: 'Owner DM',
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
  getDb()
    .prepare('INSERT INTO user_dms (user_id, channel_type, messaging_group_id, resolved_at) VALUES (?, ?, ?, ?)')
    .run(`whatsapp:${OWNER_JID}`, 'whatsapp', 'mg-dm-owner', now());

  deliver.mockReset().mockResolvedValue('wa-msg-id');
  isGroupMember.mockReset().mockResolvedValue(true);
  wakeContainer.mockClear();
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('joining a group', () => {
  it('asks the owner in DM and stays silent in the group', async () => {
    await handleGroupJoined('whatsapp', GROUP_JID, 'Berthelot Alumni');

    expect(sentTo(OWNER_JID)).toHaveLength(1);
    expect(textOf(sentTo(OWNER_JID)[0])).toContain('Berthelot Alumni');
    expect(textOf(sentTo(OWNER_JID)[0])).toContain('raymond');
    expect(sentTo(GROUP_JID)).toHaveLength(0);
    expect(getPendingPersonaSetup(groupMg().id)?.stage).toBe('awaiting_persona');
    expect(getMessagingGroupAgents(groupMg().id)).toHaveLength(0);
  });

  it('asks only once for the same group', async () => {
    await handleGroupJoined('whatsapp', GROUP_JID, 'Berthelot Alumni');
    await handleGroupJoined('whatsapp', GROUP_JID, 'Berthelot Alumni');
    expect(sentTo(OWNER_JID)).toHaveLength(1);
  });
});

describe('owner answers', () => {
  beforeEach(async () => {
    await handleGroupJoined('whatsapp', GROUP_JID, 'Berthelot Alumni');
    deliver.mockClear();
  });

  it('persona file then « ok »: wires the group and introduces once', async () => {
    expect(await interceptInbound(dm('raymond'))).toBe(true);
    // Preview goes to the owner; the group has heard nothing yet.
    expect(textOf(sentTo(OWNER_JID)[0])).toContain(INTRO);
    expect(sentTo(GROUP_JID)).toHaveLength(0);
    expect(getMessagingGroupAgents(groupMg().id)).toHaveLength(0);

    expect(await interceptInbound(dm('ok'))).toBe(true);

    const [wiring] = getMessagingGroupAgents(groupMg().id);
    expect(wiring.engage_mode).toBe('pattern');
    expect(new RegExp(wiring.engage_pattern!).test('allez poupou')).toBe(true);
    expect(new RegExp(wiring.engage_pattern!).test('@IAnn ?')).toBe(true);
    expect(sentTo(GROUP_JID).map(textOf)).toEqual([INTRO]);
    expect(getIntroducedAt(groupMg().id)).not.toBeNull();
    expect(getPendingPersonaSetup(groupMg().id)).toBeUndefined();
    expect(groupMg().unknown_sender_policy).toBe('public');

    const folder = fs.readdirSync(`${TEST_DIR}/groups`)[0];
    expect(folder).toMatch(/^whatsapp_berthelot-alumni-/);
    expect(fs.readFileSync(`${TEST_DIR}/groups/${folder}/CLAUDE.local.md`, 'utf-8')).toContain('# Raymond');
    const container = JSON.parse(fs.readFileSync(`${TEST_DIR}/groups/${folder}/container.json`, 'utf-8'));
    expect(container).toMatchObject({ assistantName: 'Raymond', groupName: 'Raymond', model: 'test/model' });

    // With nothing pending, the owner's DM is an ordinary message again.
    expect(await interceptInbound(dm('salut'))).toBe(false);
  });

  it('a rewritten intro replaces the proposed one, in the persona too', async () => {
    await interceptInbound(dm('raymond'));
    await interceptInbound(dm('Bonjour à tous, Raymond à votre service.'));
    await interceptInbound(dm('ok'));

    expect(sentTo(GROUP_JID).map(textOf)).toEqual(['Bonjour à tous, Raymond à votre service.']);
    const folder = fs.readdirSync(`${TEST_DIR}/groups`)[0];
    const persona = fs.readFileSync(`${TEST_DIR}/groups/${folder}/CLAUDE.local.md`, 'utf-8');
    expect(persona).toContain('Bonjour à tous, Raymond à votre service.');
    expect(persona).not.toContain(INTRO);
  });

  it('free text with « strict, direct »: no preview, strict policy', async () => {
    await interceptInbound(dm('Léa, coach de course à pied, strict, direct'));

    expect(sentTo(GROUP_JID)).toHaveLength(1);
    expect(textOf(sentTo(GROUP_JID)[0])).toContain('*Léa*');
    expect(groupMg().unknown_sender_policy).toBe('strict');
    expect(getIntroducedAt(groupMg().id)).not.toBeNull();
  });

  it('« ignore »: declines the group and never asks again', async () => {
    await interceptInbound(dm('ignore'));
    expect(groupMg().denied_at).not.toBeNull();
    expect(getPendingPersonaSetup(groupMg().id)).toBeUndefined();

    deliver.mockClear();
    await handleGroupJoined('whatsapp', GROUP_JID, 'Berthelot Alumni');
    await routeInbound(groupMessage('@IAnn ?', true));
    expect(deliver).not.toHaveBeenCalled();
    expect(sentTo(GROUP_JID)).toHaveLength(0);
  });

  it('an unknown persona name keeps the question open', async () => {
    await interceptInbound(dm('gaston'));
    expect(textOf(sentTo(OWNER_JID)[0])).toContain('raymond');
    expect(getPendingPersonaSetup(groupMg().id)?.stage).toBe('awaiting_persona');
  });

  it('does not capture the CLI admin transport nor another sender', async () => {
    // Morning briefing: cli:admin is an owner and targets the owner's DM.
    expect(await interceptInbound(dm('briefing du matin', 'cli', { senderId: 'cli:admin' }))).toBe(false);
    expect(await interceptInbound(dm('raymond', '33699999999@s.whatsapp.net'))).toBe(false);
    expect(getPendingPersonaSetup(groupMg().id)?.stage).toBe('awaiting_persona');
    expect(deliver).not.toHaveBeenCalled();
  });

  it('bot not in the group: wires nothing, then goes through on « ok »', async () => {
    isGroupMember.mockResolvedValue(false);
    await interceptInbound(dm('raymond, direct'));

    expect(getMessagingGroupAgents(groupMg().id)).toHaveLength(0);
    expect(sentTo(GROUP_JID)).toHaveLength(0);
    expect(getIntroducedAt(groupMg().id)).toBeNull();
    expect(textOf(sentTo(OWNER_JID)[0])).toContain('pas membre');

    isGroupMember.mockResolvedValue(true);
    await interceptInbound(dm('ok'));
    expect(sentTo(GROUP_JID).map(textOf)).toEqual([INTRO]);
    expect(getIntroducedAt(groupMg().id)).not.toBeNull();
  });

  it('intro not confirmed by the platform: not marked as introduced', async () => {
    deliver.mockImplementation(async (platformId: string) => (platformId === GROUP_JID ? undefined : 'wa-msg-id'));
    await interceptInbound(dm('raymond, direct'));

    expect(getIntroducedAt(groupMg().id)).toBeNull();
    expect(getPendingPersonaSetup(groupMg().id)?.stage).toBe('awaiting_ok');
    expect(textOf(sentTo(OWNER_JID).at(-1)!)).toContain("n'a pas confirmé");
  });
});

describe('group sync', () => {
  it('takes the first list as a baseline, then treats an unknown group as a join', async () => {
    await handleGroupsSynced('whatsapp', [{ platformId: '120363000000000009@g.us', name: 'Vieux groupe' }]);
    expect(deliver).not.toHaveBeenCalled();

    await handleGroupsSynced('whatsapp', [
      { platformId: '120363000000000009@g.us', name: 'Vieux groupe' },
      { platformId: GROUP_JID, name: 'Berthelot Alumni' },
    ]);
    expect(sentTo(OWNER_JID)).toHaveLength(1);
    expect(textOf(sentTo(OWNER_JID)[0])).toContain('Berthelot Alumni');
    expect(getPendingPersonaSetup(groupMg().id)).toBeDefined();
  });
});

describe('router', () => {
  it('a mention in an unwired group starts a setup, not a channel-approval card', async () => {
    await routeInbound(groupMessage('@IAnn tu es là ?', true));

    expect(getPendingPersonaSetup(groupMg().id)?.stage).toBe('awaiting_persona');
    expect(sentTo(OWNER_JID)).toHaveLength(1);
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM pending_channel_approvals').get()).toEqual({ n: 0 });
  });

  it('plain chatter in an unwired group stays silent', async () => {
    await routeInbound(groupMessage('on mange quoi ce soir', false));
    expect(deliver).not.toHaveBeenCalled();
    expect(getMessagingGroupByPlatform('whatsapp', GROUP_JID)).toBeUndefined();
  });

  it('a wired persona wakes on its name, on a mention or reply, and not on chatter', async () => {
    await handleGroupJoined('whatsapp', GROUP_JID, 'Berthelot Alumni');
    await interceptInbound(dm('raymond, direct'));

    await routeInbound(groupMessage('on mange quoi ce soir', false));
    expect(wakeContainer).not.toHaveBeenCalled();

    await routeInbound(groupMessage('Raymond, un conseil ?', false));
    expect(wakeContainer).toHaveBeenCalledTimes(1);

    // Reply to one of its messages: no name in the text, the adapter flags it.
    await routeInbound(groupMessage('et pour les pneus ?', true));
    expect(wakeContainer).toHaveBeenCalledTimes(2);
  });
});
