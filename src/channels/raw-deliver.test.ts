import { describe, expect, it, vi } from 'vitest';

import type { ChannelAdapter, OutboundMessage } from './adapter.js';
import { RAW_DELIVER_MAX_CHARS, rawDeliver } from './raw-deliver.js';
import type { MessagingGroup } from '../types.js';

const TO = { channelType: 'whatsapp', platformId: '33610516560-1584221738@g.us', threadId: null };

function adapter(result: string | undefined, connected = true) {
  const delivered: OutboundMessage[] = [];
  const a = {
    isConnected: () => connected,
    deliver: vi.fn(async (_p: string, _t: string | null, m: OutboundMessage) => {
      delivered.push(m);
      return result;
    }),
  } as unknown as ChannelAdapter;
  return { a, delivered };
}

function deps(a: ChannelAdapter | undefined, known = true) {
  return {
    getMessagingGroupByPlatform: () => (known ? ({ id: 'mg-1' } as MessagingGroup) : undefined),
    getChannelAdapter: () => a,
  };
}

describe('rawDeliver', () => {
  it('delivers the text verbatim and returns the platform id', async () => {
    const { a, delivered } = adapter('WAMID-1');
    const r = await rawDeliver(TO, 'LP-2610-04 — *fait*', deps(a));
    expect(r).toEqual({ ok: true, messageId: 'WAMID-1' });
    expect(delivered).toEqual([{ kind: 'chat', content: { text: 'LP-2610-04 — *fait*' } }]);
  });

  it('refuses a group NanoClaw does not know', async () => {
    const { a } = adapter('WAMID-1');
    expect(await rawDeliver(TO, 'x', deps(a, false))).toEqual({ ok: false, error: 'unknown_messaging_group' });
    expect(a.deliver).not.toHaveBeenCalled();
  });

  it('refuses the cli channel itself', async () => {
    const { a } = adapter('id');
    const r = await rawDeliver({ ...TO, channelType: 'cli' }, 'x', deps(a));
    expect(r).toEqual({ ok: false, error: 'cli_target_refused' });
  });

  it('refuses empty and oversized texts', async () => {
    const { a } = adapter('id');
    expect(await rawDeliver(TO, '  ', deps(a))).toEqual({ ok: false, error: 'empty_text' });
    expect(await rawDeliver(TO, 'x'.repeat(RAW_DELIVER_MAX_CHARS + 1), deps(a))).toEqual({
      ok: false,
      error: 'text_too_long',
    });
    expect(a.deliver).not.toHaveBeenCalled();
  });

  it('reports a missing or disconnected adapter', async () => {
    expect(await rawDeliver(TO, 'x', deps(undefined))).toEqual({ ok: false, error: 'adapter_unavailable' });
    const { a } = adapter('id', false);
    expect(await rawDeliver(TO, 'x', deps(a))).toEqual({ ok: false, error: 'adapter_unavailable' });
  });

  it('treats a delivery without message id as not confirmed (queued or dropped)', async () => {
    const { a } = adapter(undefined);
    expect(await rawDeliver(TO, 'x', deps(a))).toEqual({ ok: false, error: 'not_confirmed' });
  });
});
