import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from './db/connection.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { getPendingMessages } from './db/messages-in.js';
import { MockProvider } from './providers/mock.js';
import type { AgentProvider, AgentQuery, ProviderEvent } from './providers/types.js';
import { runPollLoop } from './poll-loop.js';

/** Provider that fails every turn the same way — a down OpenCode server. */
class FailingProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;
  constructor(private readonly message: string) {}
  isSessionInvalid(): boolean {
    return false;
  }
  query(): AgentQuery {
    const message = this.message;
    const events: AsyncIterable<ProviderEvent> = {
      // eslint-disable-next-line require-yield
      async *[Symbol.asyncIterator]() {
        throw new Error(message);
      },
    };
    return { push: () => {}, end: () => {}, events, abort: () => {} };
  }
}

beforeEach(() => {
  initTestSessionDb();
  // Seed a destination so output parsing can resolve "discord-test" → routing
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('discord-test', 'Discord Test', 'channel', 'discord', 'chan-1', NULL)`,
    )
    .run();
});

afterEach(() => {
  closeSessionDb();
});

function insertMessage(id: string, content: object, opts?: { platformId?: string; channelType?: string; threadId?: string }) {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES (?, 'chat', datetime('now'), 'pending', ?, ?, ?, ?)`,
    )
    .run(id, opts?.platformId ?? null, opts?.channelType ?? null, opts?.threadId ?? null, JSON.stringify(content));
}

describe('poll loop integration', () => {
  it('should pick up a message, process it, and write a response', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'What is the meaning of life?' }, { platformId: 'chan-1', channelType: 'discord', threadId: 'thread-1' });

    const provider = new MockProvider({}, () => '<message to="discord-test">42</message>');

    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('42');
    expect(out[0].platform_id).toBe('chan-1');
    expect(out[0].channel_type).toBe('discord');
    expect(out[0].in_reply_to).toBe('m1');

    // Input message should be acked (not pending)
    const pending = getPendingMessages();
    expect(pending).toHaveLength(0);

    await loopPromise.catch(() => {});
  });

  it('should process multiple messages in a batch', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'Hello' });
    insertMessage('m2', { sender: 'Bob', text: 'World' });

    const provider = new MockProvider({}, () => '<message to="discord-test">Got both messages</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('Got both messages');

    await loopPromise.catch(() => {});
  });

  it('reports a repeated provider failure once, not on every message', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'Hello' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new FailingProvider(
      'OpenCode server exited with code 1\nServer output: \u001b[91mFailed to start server on port 4096\u001b[0m',
    );
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 8000);

    await waitFor(() => getUndeliveredMessages().length > 0, 3000);

    const first = getUndeliveredMessages();
    expect(first).toHaveLength(1);
    const text = JSON.parse(first[0].content).text;
    expect(text).toContain('Failed to start server on port 4096');
    expect(text).not.toContain('\u001b');

    // More traffic arrives while the provider is still broken.
    insertMessage('m2', { sender: 'Bob', text: 'Still there?' }, { platformId: 'chan-1', channelType: 'discord' });
    await waitFor(() => getPendingMessages().length === 0, 3000);
    insertMessage('m3', { sender: 'Carol', text: 'Hello?' }, { platformId: 'chan-1', channelType: 'discord' });
    await waitFor(() => getPendingMessages().length === 0, 3000);

    controller.abort();

    // Same failure — reported once, not once per message.
    expect(getUndeliveredMessages()).toHaveLength(1);

    await loopPromise.catch(() => {});
  });

  it('should process messages arriving after loop starts', async () => {
    const provider = new MockProvider({}, () => '<message to="discord-test">Processed</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 3000);

    // Insert message after loop has started
    await sleep(200);
    insertMessage('m-late', { sender: 'Charlie', text: 'Late arrival' });

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out.length).toBeGreaterThanOrEqual(1);

    await loopPromise.catch(() => {});
  });
});

// Helper: run poll loop until aborted or timeout
async function runPollLoopWithTimeout(provider: AgentProvider, signal: AbortSignal, timeoutMs: number): Promise<void> {
  return Promise.race([
    runPollLoop({
      provider,
      cwd: '/tmp',
      signal,
    }),
    new Promise<void>((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    }),
    new Promise<void>((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
  ]);
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await sleep(50);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
