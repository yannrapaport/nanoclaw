/**
 * nc-send — push a proactive message to a wired channel via the CLI socket.
 *
 * Usage:
 *   pnpm tsx scripts/send.ts <alias> <message...>
 *   pnpm tsx scripts/send.ts --list
 *
 * Pipes the message into the daemon's `cli.sock` admin transport
 * (see src/channels/cli.ts), which routes it as an InboundEvent to the
 * resolved (channelType, platformId, threadId) — i.e. the wired agent
 * (Herbert, Coach Roger, …) sees it as a message in that group and
 * responds. NOT a raw delivery: the agent re-engages with its persona.
 *
 * Alias resolution (case-insensitive, in order):
 *   1. exact match on agent_groups.folder, with or without channel prefix
 *      (e.g. `la-plushy-team` matches `whatsapp_la-plushy-team`)
 *   2. exact match on messaging_groups.name
 *   3. substring match across folder + name; ambiguous matches error out
 *
 * Exit codes:
 *   0 OK | 1 usage | 2 socket unreachable | 3 alias unresolved | 4 ambiguous
 */
import net from 'net';
import path from 'path';

import Database from 'better-sqlite3';

import { DATA_DIR } from '../src/config.js';

interface GroupRow {
  channel_type: string;
  platform_id: string;
  group_name: string;
  agent_name: string;
  folder: string;
}

function dbPath(): string {
  return path.join(DATA_DIR, 'v2.db');
}

function socketPath(): string {
  return path.join(DATA_DIR, 'cli.sock');
}

function loadGroups(): GroupRow[] {
  const db = new Database(dbPath(), { readonly: true });
  try {
    return db
      .prepare(
        `SELECT mg.channel_type, mg.platform_id, mg.name AS group_name,
                ag.name AS agent_name, ag.folder
           FROM messaging_groups mg
           JOIN messaging_group_agents mga ON mga.messaging_group_id = mg.id
           JOIN agent_groups ag ON ag.id = mga.agent_group_id
       ORDER BY ag.name, mg.name`,
      )
      .all() as GroupRow[];
  } finally {
    db.close();
  }
}

// Folder convention is "<channel>_<slug>"; strip the channel piece for the alias.
function stripChannelPrefix(folder: string): string {
  const idx = folder.indexOf('_');
  return idx > 0 ? folder.slice(idx + 1) : folder;
}

function slugify(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Canonical alias per group. Folder slug when the folder owns a single mg
 * (e.g. `alex-nat-yannus`); slugified group name otherwise (e.g. the six
 * `tccv-test` mgs each get `kania-romain-tccv`, `poule-14`, …).
 */
function buildAliasMap(groups: GroupRow[]): Map<GroupRow, string> {
  const folderCounts = new Map<string, number>();
  for (const g of groups) folderCounts.set(g.folder, (folderCounts.get(g.folder) ?? 0) + 1);

  const map = new Map<GroupRow, string>();
  for (const g of groups) {
    const folderSlug = stripChannelPrefix(g.folder);
    map.set(g, folderCounts.get(g.folder) === 1 ? folderSlug : slugify(g.group_name));
  }
  return map;
}

type ResolveResult = { ok: GroupRow } | { error: 'not_found' } | { error: 'ambiguous'; candidates: GroupRow[] };

function resolveAlias(input: string, groups: GroupRow[], aliases: Map<GroupRow, string>): ResolveResult {
  const q = input.toLowerCase();

  // 1. exact canonical alias
  const aliasExact = groups.filter((g) => aliases.get(g) === q);
  if (aliasExact.length === 1) return { ok: aliasExact[0] };
  if (aliasExact.length > 1) return { error: 'ambiguous', candidates: aliasExact };

  // 2. exact group name (case-insensitive)
  const nameExact = groups.filter((g) => g.group_name.toLowerCase() === q);
  if (nameExact.length === 1) return { ok: nameExact[0] };
  if (nameExact.length > 1) return { error: 'ambiguous', candidates: nameExact };

  // 3. substring across alias + name
  const fuzzy = groups.filter((g) => {
    const a = aliases.get(g) ?? '';
    return a.includes(q) || g.group_name.toLowerCase().includes(q);
  });
  if (fuzzy.length === 1) return { ok: fuzzy[0] };
  if (fuzzy.length > 1) return { error: 'ambiguous', candidates: fuzzy };

  return { error: 'not_found' };
}

function printList(groups: GroupRow[], aliases: Map<GroupRow, string>): void {
  if (groups.length === 0) {
    console.error('No wired messaging groups found.');
    return;
  }
  const aliasWidth = Math.max(5, ...groups.map((g) => (aliases.get(g) ?? '').length));
  const nameWidth = Math.max(4, ...groups.map((g) => g.group_name.length));
  const agentWidth = Math.max(5, ...groups.map((g) => g.agent_name.length));
  console.log(
    `${'ALIAS'.padEnd(aliasWidth)}  ${'NAME'.padEnd(nameWidth)}  ${'AGENT'.padEnd(agentWidth)}  CHANNEL`,
  );
  for (const g of groups) {
    const alias = (aliases.get(g) ?? '').padEnd(aliasWidth);
    const name = g.group_name.padEnd(nameWidth);
    const agent = g.agent_name.padEnd(agentWidth);
    console.log(`${alias}  ${name}  ${agent}  ${g.channel_type}`);
  }
}

function pushToSocket(group: GroupRow, text: string): Promise<number> {
  return new Promise((resolve) => {
    const sock = socketPath();
    const socket = net.connect(sock);

    socket.on('error', (err) => {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT' || e.code === 'ECONNREFUSED') {
        console.error(`NanoClaw daemon not reachable at ${sock}.`);
      } else {
        console.error('CLI socket error:', err.message);
      }
      resolve(2);
    });

    socket.on('connect', () => {
      const payload = {
        text,
        to: {
          channelType: group.channel_type,
          platformId: group.platform_id,
          threadId: null,
        },
        sender: 'cli',
        senderId: 'cli:admin',
      };
      socket.write(JSON.stringify(payload) + '\n', () => {
        socket.end();
      });
    });

    socket.on('close', () => resolve(0));
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: pnpm tsx scripts/send.ts <alias> <message...>');
    console.error('       pnpm tsx scripts/send.ts --list');
    process.exit(1);
  }

  const groups = loadGroups();
  const aliases = buildAliasMap(groups);

  if (args[0] === '--list' || args[0] === '-l') {
    printList(groups, aliases);
    process.exit(0);
  }

  if (args.length < 2) {
    console.error('Missing message. Usage: pnpm tsx scripts/send.ts <alias> <message...>');
    process.exit(1);
  }

  const alias = args[0];
  const message = args.slice(1).join(' ');

  const resolved = resolveAlias(alias, groups, aliases);
  if ('error' in resolved) {
    if (resolved.error === 'not_found') {
      console.error(`No group matches "${alias}". Try \`pnpm tsx scripts/send.ts --list\`.`);
      process.exit(3);
    }
    console.error(`Alias "${alias}" is ambiguous. Candidates:`);
    for (const c of resolved.candidates) {
      console.error(`  ${aliases.get(c) ?? '(?)'}  (${c.group_name}, ${c.agent_name})`);
    }
    process.exit(4);
  }

  console.error(
    `→ ${resolved.ok.agent_name} on ${resolved.ok.channel_type}/${resolved.ok.group_name} (${resolved.ok.platform_id})`,
  );
  const code = await pushToSocket(resolved.ok, message);
  process.exit(code);
}

void main();
