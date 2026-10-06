/**
 * Group-membership events, from channel adapters to whichever module cares.
 *
 * Lives outside src/index.ts for the same reason as response-registry.ts:
 * modules register at import time and must not import the entry point.
 * Without a registered handler the events are dropped.
 */
import { log } from './log.js';

export interface GroupEventHandlers {
  /** The bot was just added to a group. */
  joined(channelType: string, platformId: string, name?: string): Promise<void>;
  /** Complete list of the groups the bot sits in, after an adapter sync. */
  synced(channelType: string, groups: Array<{ platformId: string; name?: string }>): Promise<void>;
}

let handlers: GroupEventHandlers | null = null;

export function setGroupEventHandlers(h: GroupEventHandlers): void {
  if (handlers) log.warn('Group event handlers overwritten');
  handlers = h;
}

export function notifyGroupJoined(channelType: string, platformId: string, name?: string): void {
  void handlers?.joined(channelType, platformId, name).catch((err) => {
    log.error('Group-joined handler threw', { channelType, platformId, err });
  });
}

export function notifyGroupsSynced(channelType: string, groups: Array<{ platformId: string; name?: string }>): void {
  void handlers?.synced(channelType, groups).catch((err) => {
    log.error('Groups-synced handler threw', { channelType, err });
  });
}
