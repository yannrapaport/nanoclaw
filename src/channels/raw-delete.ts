/**
 * Raw delete — remove for everyone a message the bot posted in a wired
 * channel, without waking any agent.
 *
 * `{delete: true, messageId, to}` on cli.sock. Used to clean up a message an
 * agent should not have sent (e.g. an end-of-turn recap leaking into a group).
 *
 * Same guards as raw-deliver: the target must be a messaging group already
 * known to NanoClaw, and `cli` itself is refused. The platform only lets the
 * bot delete its own messages, so a wrong id fails rather than touching
 * someone else's.
 */
import type { ChannelAdapter, DeliveryAddress } from './adapter.js';
import type { MessagingGroup } from '../types.js';

export type RawDeleteResult = { ok: true; messageId: string } | { ok: false; error: string };

export interface RawDeleteDeps {
  getMessagingGroupByPlatform(channelType: string, platformId: string): MessagingGroup | undefined;
  getChannelAdapter(channelType: string): ChannelAdapter | undefined;
}

export async function rawDelete(to: DeliveryAddress, messageId: string, deps: RawDeleteDeps): Promise<RawDeleteResult> {
  if (!messageId.trim()) return { ok: false, error: 'empty_message_id' };
  if (to.channelType === 'cli') return { ok: false, error: 'cli_target_refused' };

  const mg = deps.getMessagingGroupByPlatform(to.channelType, to.platformId);
  if (!mg) return { ok: false, error: 'unknown_messaging_group' };

  const adapter = deps.getChannelAdapter(to.channelType);
  if (!adapter || !adapter.isConnected()) return { ok: false, error: 'adapter_unavailable' };
  if (!adapter.deleteMessage) return { ok: false, error: 'delete_unsupported' };

  const ok = await adapter.deleteMessage(to.platformId, messageId);
  return ok ? { ok: true, messageId } : { ok: false, error: 'not_confirmed' };
}
