/**
 * Plushy spool — host-side, deterministic hook for La Pelucherie's assistant.
 *
 * In a short, explicit list of WhatsApp groups (PLUSHY_SPOOL_GROUPS), a
 * message that calls Plushy (`@Plushy`, or a native mention of the bot) is
 * written to a spool directory as one JSON file. lp-inbox-assistant reads the
 * spool and turns the request into a task. Nothing else happens here: no LLM,
 * no container, no secret, no approval card, no reply. Every other message of
 * those groups is ignored without any write.
 *
 * Inert while PLUSHY_SPOOL_GROUPS is empty (the default).
 *
 * File format (v1): `<dir>/new/<epochMs>-<safeMessageId>.json`, written to
 * `<dir>/tmp/` then renamed, so a reader never sees a half-written file.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { ASSISTANT_NAME } from './config.js';
import { readEnvFile } from './env.js';
import { log } from './log.js';
import type { InboundEvent } from './channels/adapter.js';

// The bot's own WhatsApp ids, as a raw mention shows them in the text
// (LID and phone number of the +33 7 49 24 29 02 account). The adapter
// rewrites a native mention of the bot's LID into `@${ASSISTANT_NAME}`.
const BOT_IDS = ['271142006857729', '33749242902'];

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildCallPattern(assistantName: string = ASSISTANT_NAME): RegExp {
  const names = ['plushy', escapeRe(assistantName), ...BOT_IDS];
  // Not preceded by a word char (so `x@plushy` in an address does not count),
  // and followed by a word boundary (`@Plushyboard` does not count).
  return new RegExp(`(?<![\\w.])@(?:${names.join('|')})\\b`, 'i');
}

export interface SpoolConfig {
  groups: Set<string>;
  dir: string;
}

export function loadSpoolConfig(): SpoolConfig {
  const env = readEnvFile(['PLUSHY_SPOOL_GROUPS', 'PLUSHY_SPOOL_DIR']);
  const rawGroups = process.env.PLUSHY_SPOOL_GROUPS ?? env.PLUSHY_SPOOL_GROUPS ?? '';
  const dir =
    process.env.PLUSHY_SPOOL_DIR ||
    env.PLUSHY_SPOOL_DIR ||
    path.join(process.env.HOME || os.homedir(), '.local', 'share', 'plushy-spool');
  const groups = new Set(
    rawGroups
      .split(',')
      .map((g) => g.trim())
      .filter(Boolean),
  );
  return { groups, dir };
}

export interface SpoolRecord {
  v: 1;
  channelType: string;
  platformId: string;
  messageId: string;
  timestamp: string;
  sender: string;
  senderName: string;
  text: string;
  forwarded: boolean;
  spooledAt: string;
}

function parseContent(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Returns the spool record when the event must be spooled, else null.
 * Pure: no I/O.
 */
export function spoolRecordFor(
  event: InboundEvent,
  cfg: SpoolConfig,
  pattern: RegExp = buildCallPattern(),
  now: Date = new Date(),
): SpoolRecord | null {
  if (event.channelType !== 'whatsapp') return null;
  if (!cfg.groups.has(event.platformId)) return null;
  const c = parseContent(event.message.content);
  const text = typeof c.text === 'string' ? c.text : '';
  if (!text || !pattern.test(text)) return null;
  if (c.fromMe === true || c.isBotMessage === true) return null;
  return {
    v: 1,
    channelType: event.channelType,
    platformId: event.platformId,
    messageId: event.message.id,
    timestamp: event.message.timestamp,
    sender: typeof c.sender === 'string' ? c.sender : '',
    senderName: typeof c.senderName === 'string' ? c.senderName : '',
    text,
    forwarded: c.isForwarded === true,
    spooledAt: now.toISOString(),
  };
}

export function writeSpoolRecord(rec: SpoolRecord, dir: string): string {
  const tmpDir = path.join(dir, 'tmp');
  const newDir = path.join(dir, 'new');
  fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(newDir, { recursive: true, mode: 0o700 });
  const safeId = rec.messageId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || 'noid';
  const name = `${Date.now()}-${safeId}.json`;
  const tmp = path.join(tmpDir, name);
  fs.writeFileSync(tmp, JSON.stringify(rec) + '\n', { mode: 0o600 });
  const final = path.join(newDir, name);
  fs.renameSync(tmp, final);
  return final;
}

let cached: SpoolConfig | null = null;

/**
 * Router hook. Never throws: a spool failure is logged and the router goes on.
 * Returns true when the message was spooled.
 */
export function plushySpoolHook(event: InboundEvent, cfg?: SpoolConfig): boolean {
  try {
    const conf = cfg ?? (cached ??= loadSpoolConfig());
    if (conf.groups.size === 0) return false;
    const rec = spoolRecordFor(event, conf);
    if (!rec) return false;
    const file = writeSpoolRecord(rec, conf.dir);
    log.info('Plushy call spooled', { platformId: rec.platformId, messageId: rec.messageId, file });
    return true;
  } catch (err) {
    log.error('Plushy spool failed', { platformId: event.platformId, err });
    return false;
  }
}
