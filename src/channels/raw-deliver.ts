/**
 * Raw delivery — post a text verbatim to a wired channel, without waking
 * any agent.
 *
 * The admin transport (`{text, to}` on cli.sock) injects an InboundEvent:
 * the wired agent reads it as a prompt and answers with its persona. That is
 * wrong for a caller that already holds the final text (lp-inbox posting a
 * deliverable with its `LP-xxxx` reference): the agent would rephrase it.
 *
 * `{deliver: true, text, to}` takes this path instead and calls the target
 * adapter's `deliver()` directly. It answers on the socket with one JSON line,
 * so the caller knows whether the platform accepted the message — the routed
 * admin transport is fire-and-forget and can't tell.
 *
 * Guards: the target must be a messaging group already known to NanoClaw
 * (a typo or a bug in the caller can't reach an arbitrary WhatsApp number),
 * `cli` itself is refused, and the text is capped.
 */
import type { ChannelAdapter, DeliveryAddress } from './adapter.js';
import type { MessagingGroup } from '../types.js';

export const RAW_DELIVER_MAX_CHARS = 4000;

export type RawDeliverResult = { ok: true; messageId: string } | { ok: false; error: string };

export interface RawDeliverDeps {
  getMessagingGroupByPlatform(channelType: string, platformId: string): MessagingGroup | undefined;
  getChannelAdapter(channelType: string): ChannelAdapter | undefined;
}

export async function rawDeliver(to: DeliveryAddress, text: string, deps: RawDeliverDeps): Promise<RawDeliverResult> {
  if (!text.trim()) return { ok: false, error: 'empty_text' };
  if (text.length > RAW_DELIVER_MAX_CHARS) return { ok: false, error: 'text_too_long' };
  if (to.channelType === 'cli') return { ok: false, error: 'cli_target_refused' };

  const mg = deps.getMessagingGroupByPlatform(to.channelType, to.platformId);
  if (!mg) return { ok: false, error: 'unknown_messaging_group' };

  const adapter = deps.getChannelAdapter(to.channelType);
  if (!adapter || !adapter.isConnected()) return { ok: false, error: 'adapter_unavailable' };

  // WhatsApp returns undefined when the message was queued (socket down) or
  // when the platform gave no message id even after its own retry. Either way
  // nothing proves the message reached the chat: report it as not delivered.
  const messageId = await adapter.deliver(to.platformId, to.threadId, { kind: 'chat', content: { text } });
  if (!messageId) return { ok: false, error: 'not_confirmed' };
  return { ok: true, messageId };
}
