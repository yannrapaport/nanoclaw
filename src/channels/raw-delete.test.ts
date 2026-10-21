import { describe, expect, it, vi } from 'vitest';

import type { ChannelAdapter } from './adapter.js';
import { rawDelete } from './raw-delete.js';
import type { MessagingGroup } from '../types.js';

const TO = { channelType: 'whatsapp', platformId: '120363429334003087@g.us', threadId: null };

function adapter(result: boolean, connected = true, supported = true) {
  const a = {
    isConnected: () => connected,
    deleteMessage: supported ? vi.fn(async () => result) : undefined,
  } as unknown as ChannelAdapter;
  return a;
}

function deps(a: ChannelAdapter | undefined, known = true) {
  return {
    getMessagingGroupByPlatform: () => (known ? ({ id: 'mg-1' } as MessagingGroup) : undefined),
    getChannelAdapter: () => a,
  };
}

describe('rawDelete', () => {
  it('deletes the message on the target channel', async () => {
    const a = adapter(true);
    expect(await rawDelete(TO, '3EB0ABC', deps(a))).toEqual({ ok: true, messageId: '3EB0ABC' });
    expect(a.deleteMessage).toHaveBeenCalledWith(TO.platformId, '3EB0ABC');
  });

  it('refuses a group NanoClaw does not know', async () => {
    const a = adapter(true);
    expect(await rawDelete(TO, 'x', deps(a, false))).toEqual({ ok: false, error: 'unknown_messaging_group' });
    expect(a.deleteMessage).not.toHaveBeenCalled();
  });

  it('refuses the cli channel and an empty id', async () => {
    const a = adapter(true);
    expect(await rawDelete({ ...TO, channelType: 'cli' }, 'x', deps(a))).toEqual({
      ok: false,
      error: 'cli_target_refused',
    });
    expect(await rawDelete(TO, ' ', deps(a))).toEqual({ ok: false, error: 'empty_message_id' });
  });

  it('reports a missing, disconnected or unsupporting adapter', async () => {
    expect(await rawDelete(TO, 'x', deps(undefined))).toEqual({ ok: false, error: 'adapter_unavailable' });
    expect(await rawDelete(TO, 'x', deps(adapter(true, false)))).toEqual({ ok: false, error: 'adapter_unavailable' });
    expect(await rawDelete(TO, 'x', deps(adapter(true, true, false)))).toEqual({
      ok: false,
      error: 'delete_unsupported',
    });
  });

  it('reports a platform refusal', async () => {
    expect(await rawDelete(TO, 'x', deps(adapter(false)))).toEqual({ ok: false, error: 'not_confirmed' });
  });
});
