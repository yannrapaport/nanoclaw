/**
 * cli.sock `{deliver: true}` end to end on a real Unix socket: the line goes
 * to the target adapter's deliver(), the agent path is never taken, and the
 * daemon answers on the socket.
 */
import fs from 'fs';
import net from 'net';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_DIR = '/tmp/nanoclaw-test-cli-raw';

vi.mock('../config.js', async () => {
  const actual = await vi.importActual('../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-cli-raw' };
});

const waDeliver = vi.fn(async () => 'WAMID-42');
vi.mock('../db/messaging-groups.js', () => ({
  getMessagingGroupByPlatform: (ct: string, pid: string) =>
    ct === 'whatsapp' && pid === 'grp@g.us' ? { id: 'mg-1' } : undefined,
}));
vi.mock('./channel-registry.js', () => {
  const regs = new Map<string, { factory: () => unknown }>();
  return {
    registerChannelAdapter: (name: string, r: { factory: () => unknown }) => regs.set(name, r),
    getChannelAdapter: (ct: string) =>
      ct === 'whatsapp' ? { isConnected: () => true, deliver: waDeliver } : undefined,
    __regs: regs,
  };
});

async function exchange(line: object): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = net.connect(path.join(TEST_DIR, 'cli.sock'));
    let buf = '';
    s.on('error', reject);
    s.on('connect', () => s.write(JSON.stringify(line) + '\n'));
    s.on('data', (c) => {
      buf += c.toString();
      if (buf.includes('\n')) {
        s.destroy();
        resolve(buf.trim());
      }
    });
  });
}

describe('cli.sock raw delivery', () => {
  let adapter: { setup(c: unknown): Promise<void>; teardown(): Promise<void> };
  const onInboundEvent = vi.fn();
  const onInbound = vi.fn();

  beforeEach(async () => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    waDeliver.mockClear();
    onInboundEvent.mockClear();
    await import('./cli.js');
    const reg = (await import('./channel-registry.js')) as unknown as {
      __regs: Map<string, { factory: () => typeof adapter }>;
    };
    adapter = reg.__regs.get('cli')!.factory();
    await adapter.setup({ onInbound, onInboundEvent, onMetadata: vi.fn(), onAction: vi.fn() });
  });

  afterEach(async () => {
    await adapter.teardown();
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('delivers verbatim, answers with the message id, never wakes an agent', async () => {
    const to = { channelType: 'whatsapp', platformId: 'grp@g.us', threadId: null };
    const answer = await exchange({ deliver: true, text: 'LP-2610-04 : fait', to });
    expect(JSON.parse(answer)).toEqual({ ok: true, messageId: 'WAMID-42' });
    expect(waDeliver).toHaveBeenCalledWith('grp@g.us', null, { kind: 'chat', content: { text: 'LP-2610-04 : fait' } });
    expect(onInboundEvent).not.toHaveBeenCalled();
    expect(onInbound).not.toHaveBeenCalled();
  });

  it('answers an error for an unknown group, without delivering', async () => {
    const to = { channelType: 'whatsapp', platformId: '33600000000@s.whatsapp.net', threadId: null };
    const answer = await exchange({ deliver: true, text: 'x', to });
    expect(JSON.parse(answer)).toEqual({ ok: false, error: 'unknown_messaging_group' });
    expect(waDeliver).not.toHaveBeenCalled();
    expect(onInboundEvent).not.toHaveBeenCalled();
  });

  it('answers missing_to when no address is given', async () => {
    expect(JSON.parse(await exchange({ deliver: true, text: 'x' }))).toEqual({ ok: false, error: 'missing_to' });
    expect(onInbound).not.toHaveBeenCalled();
  });
});
