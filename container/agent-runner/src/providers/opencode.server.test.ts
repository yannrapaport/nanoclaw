import { describe, it, expect } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { startOpencodeServer, killServerTree, destroySharedRuntime, OpenCodeProvider } from './opencode.js';

const SHIM = `#!/usr/bin/env bun
// Fake \`opencode serve\` for tests: a wrapper process that spawns the real
// listener as a child, the way the opencode npm package launches its
// platform binary. Killing only the wrapper leaves the child holding the port.
const portArg = process.argv.find((a) => a.startsWith('--port='));
const port = Number(portArg.split('=')[1]);

if (process.env.FAKE_OPENCODE_CHILD === '1') {
  try {
    Bun.serve({ port, hostname: '127.0.0.1', fetch: () => new Response('ok') });
  } catch {
    console.log(\`Failed to start server on port \${port}\`);
    process.exit(1);
  }
  console.log(\`opencode server listening on http://127.0.0.1:\${port}\`);
  setInterval(() => {}, 60_000);
} else {
  const child = Bun.spawn([process.execPath, import.meta.path, ...process.argv.slice(2)], {
    env: { ...process.env, FAKE_OPENCODE_CHILD: '1' },
    stdio: ['inherit', 'inherit', 'inherit'],
  });
  process.exit(await child.exited);
}
`;

function portFree(port: number): boolean {
  try {
    const server = Bun.serve({ port, hostname: '127.0.0.1', fetch: () => new Response('') });
    server.stop(true);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(condition: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil timeout');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('startOpencodeServer', () => {
  it('walks past a busy port and kills the server the wrapper spawned', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fake-opencode-'));
    writeFileSync(join(dir, 'opencode'), SHIM, { mode: 0o755 });
    const prevPath = process.env.PATH;
    process.env.PATH = `${dir}:${prevPath ?? ''}`;

    // Something else already owns the base port — the state a leftover
    // server used to leave behind, which failed every later spawn.
    const blocker = Bun.serve({ port: 4096, hostname: '127.0.0.1', fetch: () => new Response('busy') });

    try {
      const { url, proc } = await startOpencodeServer({});
      const port = Number(new URL(url).port);
      expect(port).toBeGreaterThan(4096);
      expect((await fetch(url)).status).toBe(200);

      // The listener is the wrapper's child; only a process-group kill
      // frees the port.
      killServerTree(proc);
      await waitUntil(() => portFree(port), 5000);
    } finally {
      blocker.stop(true);
      process.env.PATH = prevPath;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});

const FAILING_SHIM = `#!/usr/bin/env bun
// Fake \`opencode serve\` that always fails to start, recording each attempt.
import { appendFileSync } from 'fs';
const port = Number(process.argv.find((a) => a.startsWith('--port=')).split('=')[1]);
appendFileSync(process.env.FAKE_OPENCODE_LOG, \`attempt \${port}\\n\`);
console.log(\`Failed to start server on port \${port}\`);
process.exit(1);
`;

async function drainExpectingFailure(provider: OpenCodeProvider): Promise<void> {
  const query = provider.query({ prompt: 'hi', cwd: '/tmp' });
  let failed = false;
  try {
    for await (const _ of query.events) {
      /* no events expected — the server never starts */
    }
  } catch {
    failed = true;
  }
  expect(failed).toBe(true);
}

describe('OpenCodeProvider start failures', () => {
  it('retries the spawn on the next turn instead of replaying the cached failure', async () => {
    destroySharedRuntime();
    const dir = mkdtempSync(join(tmpdir(), 'fake-opencode-'));
    writeFileSync(join(dir, 'opencode'), FAILING_SHIM, { mode: 0o755 });
    const logPath = join(dir, 'attempts.log');
    writeFileSync(logPath, '');
    const prevPath = process.env.PATH;
    process.env.PATH = `${dir}:${prevPath ?? ''}`;
    process.env.FAKE_OPENCODE_LOG = logPath;

    const attempts = (): number => readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean).length;

    try {
      const provider = new OpenCodeProvider({});
      await drainExpectingFailure(provider);
      const afterFirstTurn = attempts();
      expect(afterFirstTurn).toBeGreaterThan(0);

      // A second message must try again. Caching the rejected start promise
      // made the first failure permanent for the life of the container.
      await drainExpectingFailure(provider);
      expect(attempts()).toBeGreaterThan(afterFirstTurn);
    } finally {
      destroySharedRuntime();
      process.env.PATH = prevPath;
      delete process.env.FAKE_OPENCODE_LOG;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
