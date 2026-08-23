import * as fs from 'fs';
import { spawn, type ChildProcess } from 'child_process';

import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk';

import { registerProvider } from './provider-registry.js';
import type { AgentProvider, AgentQuery, ProviderEvent, ProviderOptions, QueryInput } from './types.js';
import { mcpServersToOpenCodeConfig } from './mcp-to-opencode.js';

function log(msg: string): void {
  console.error(`[opencode-provider] ${msg}`);
}

const SESSION_STATUS_RETRY_ERROR_AFTER = 3;

/** Stale / dead OpenCode session heuristics (complement Claude-centric host patterns). */
const STALE_SESSION_RE =
  /no conversation found|ENOENT.*\.jsonl|session.*not found|NotFoundError|connection reset|ECONNRESET|404|event timeout/i;

/** Base port for `opencode serve`; consecutive ports are tried if it is taken. */
const SERVER_PORT_BASE = 4096;
const SERVER_PORT_ATTEMPTS = 5;
const SERVER_SPAWN_TIMEOUT_MS = 45_000;

/**
 * Kill the server's whole process group.
 *
 * `opencode` is a JS wrapper that execs the platform binary as a child, so
 * SIGKILL on the process we spawned leaves the real server alive — still
 * holding its port. Every later spawn then died with "Failed to start server
 * on port 4096" and the agent answered every message with that error. We
 * spawn detached (own process group) so a negative-pid kill takes the wrapper
 * and the server down together.
 */
export function killServerTree(proc: ChildProcess): void {
  // Kill the group even when the process we spawned has already exited: the
  // wrapper can be gone while the server it started is still listening.
  if (typeof proc.pid === 'number') {
    try {
      process.kill(-proc.pid, 'SIGKILL');
      return;
    } catch {
      /* whole group already gone, or not a group leader — fall through */
    }
  }
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  try {
    proc.kill('SIGKILL');
  } catch {
    /* ignore */
  }
}

function spawnOpencodeServer(
  config: Record<string, unknown>,
  port: number,
  timeoutMs = SERVER_SPAWN_TIMEOUT_MS,
): Promise<{ url: string; proc: ChildProcess }> {
  return new Promise((resolve, reject) => {
    const hostname = '127.0.0.1';
    const proc = spawn('opencode', ['serve', `--hostname=${hostname}`, `--port=${port}`], {
      detached: true,
      env: {
        ...process.env,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      },
    });

    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(id);
      fn();
    };

    const id = setTimeout(() => {
      finish(() => {
        killServerTree(proc);
        reject(new Error(`Timeout waiting for OpenCode server to start after ${timeoutMs}ms`));
      });
    }, timeoutMs);

    let output = '';
    proc.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      for (const line of output.split('\n')) {
        if (line.startsWith('opencode server listening')) {
          const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
          if (match) {
            finish(() => resolve({ url: match[1], proc }));
          }
        }
      }
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    proc.on('exit', (code) => {
      finish(() => {
        let msg = `OpenCode server exited with code ${code}`;
        if (output.trim()) msg += `\nServer output: ${output}`;
        reject(new Error(msg));
      });
    });
    proc.on('error', (err) => {
      finish(() => reject(err));
    });
  });
}

/**
 * Start the server, walking a few ports. A leftover server from a previous
 * runtime (or anything else on the box) holding the base port is a transient
 * condition, not a reason to fail every turn until the container restarts.
 */
export async function startOpencodeServer(config: Record<string, unknown>): Promise<{ url: string; proc: ChildProcess }> {
  let lastErr: unknown;
  for (let i = 0; i < SERVER_PORT_ATTEMPTS; i++) {
    const port = SERVER_PORT_BASE + i;
    try {
      return await spawnOpencodeServer(config, port);
    } catch (err) {
      lastErr = err;
      log(`OpenCode server failed to start on port ${port}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function readClaudeMdForPrompt(): string | undefined {
  const groupPath = '/workspace/agent/CLAUDE.md';
  const groupLocalPath = '/workspace/agent/CLAUDE.local.md';
  const globalPath = '/workspace/global/CLAUDE.md';
  let content = '';
  if (fs.existsSync(groupPath)) {
    content += fs.readFileSync(groupPath, 'utf-8');
  }
  if (fs.existsSync(groupLocalPath)) {
    const local = fs.readFileSync(groupLocalPath, 'utf-8').trim();
    if (local) {
      if (content) content += '\n\n---\n\n';
      content += local;
    }
  }
  const isMain = process.env.NANOCLAW_IS_MAIN === '1';
  if (!isMain && fs.existsSync(globalPath)) {
    if (content) content += '\n\n---\n\n';
    content += fs.readFileSync(globalPath, 'utf-8');
  }
  return content || undefined;
}

function wrapPromptWithContext(text: string, systemInstructions?: string): string {
  let out = text;
  if (systemInstructions) {
    out = `<system>\n${systemInstructions}\n</system>\n\n${out}`;
  }
  const claudeMd = readClaudeMdForPrompt();
  if (claudeMd) {
    out = `<system>\n${claudeMd}\n</system>\n\n${out}`;
  }
  return out;
}

function buildOpenCodeConfig(options: ProviderOptions): Record<string, unknown> {
  const provider = process.env.OPENCODE_PROVIDER || 'anthropic';
  const model = process.env.OPENCODE_MODEL;
  const smallModel = process.env.OPENCODE_SMALL_MODEL;
  const proxyUrl = process.env.ANTHROPIC_BASE_URL;

  const providerModelId = model ? model.replace(new RegExp(`^${provider}/`), '') : undefined;
  const providerSmallModelId = smallModel ? smallModel.replace(new RegExp(`^${provider}/`), '') : undefined;
  const modelsToRegister = [providerModelId, providerSmallModelId]
    .filter(Boolean)
    .filter((mid, i, a) => a.indexOf(mid as string) === i);

  const providerOptions: Record<string, unknown> =
    provider === 'anthropic'
      ? {}
      : {
          [provider]: {
            options: { apiKey: 'placeholder', baseURL: proxyUrl },
            ...(modelsToRegister.length > 0
              ? {
                  models: Object.fromEntries(
                    modelsToRegister.map((mid) => [mid, { id: mid, name: mid, tool_call: true }]),
                  ),
                }
              : {}),
          },
        };

  const mcp = mcpServersToOpenCodeConfig(options.mcpServers);

  return {
    ...(model ? { model } : {}),
    ...(smallModel ? { small_model: smallModel } : {}),
    enabled_providers: [provider],
    permission: 'allow',
    autoupdate: false,
    snapshot: false,
    provider: providerOptions,
    mcp,
  };
}

type SharedRuntime = {
  proc: ChildProcess;
  client: OpencodeClient;
  stream: AsyncGenerator<{ type: string; properties: Record<string, unknown> }, void, void>;
  streamRelease: () => void;
};

let sharedRuntime: SharedRuntime | null = null;
let sharedConfigKey: string | null = null;
let sharedInit: Promise<SharedRuntime> | null = null;

function runtimeConfigKey(options: ProviderOptions): string {
  return JSON.stringify({
    mcp: mcpServersToOpenCodeConfig(options.mcpServers),
    model: process.env.OPENCODE_MODEL,
    small: process.env.OPENCODE_SMALL_MODEL,
    op: process.env.OPENCODE_PROVIDER,
  });
}

async function ensureSharedRuntime(options: ProviderOptions): Promise<SharedRuntime> {
  const key = runtimeConfigKey(options);
  if (sharedRuntime && sharedConfigKey === key) return sharedRuntime;

  if (sharedInit) return sharedInit;

  const init = (async () => {
    if (sharedRuntime) {
      destroySharedRuntime();
    }
    const config = buildOpenCodeConfig(options);
    installExitHooks();
    const { url, proc } = await startOpencodeServer(config);
    const client = createOpencodeClient({ baseUrl: url });
    const sub = await client.event.subscribe();
    const stream = sub.stream as AsyncGenerator<{ type: string; properties: Record<string, unknown> }, void, void>;
    const runtime: SharedRuntime = {
      proc,
      client,
      stream,
      streamRelease: () => {
        void stream.return?.(undefined);
      },
    };
    sharedRuntime = runtime;
    sharedConfigKey = key;
    return runtime;
  })();

  sharedInit = init;
  try {
    return await init;
  } finally {
    // Clear the in-flight marker whether the start succeeded or failed.
    // Leaving a *rejected* promise here made one bad start permanent: every
    // later turn awaited the same rejection, never retried the spawn, and
    // replied to every message with the identical error text.
    // Identity check: a concurrent destroy may already have swapped it.
    if (sharedInit === init) sharedInit = null;
  }
}

/**
 * A detached server does not receive the runner's signals, so kill it
 * explicitly on the way out — otherwise it survives the runner and keeps
 * holding its port for whatever starts next.
 */
let exitHooksInstalled = false;
function installExitHooks(): void {
  if (exitHooksInstalled) return;
  exitHooksInstalled = true;
  process.on('exit', () => destroySharedRuntime());
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      destroySharedRuntime();
      process.exit(signal === 'SIGINT' ? 130 : 143);
    });
  }
}

export function destroySharedRuntime(): void {
  if (sharedRuntime) {
    try {
      sharedRuntime.streamRelease();
    } catch {
      /* ignore */
    }
    killServerTree(sharedRuntime.proc);
    sharedRuntime = null;
    sharedConfigKey = null;
  }
  sharedInit = null;
}

function sessionErrorMessage(props: { error?: unknown }): string {
  const err = props.error as { data?: { message?: string } } | undefined;
  if (err && typeof err === 'object' && err.data && typeof err.data.message === 'string') {
    return err.data.message;
  }
  return JSON.stringify(props.error) || 'OpenCode session error';
}

export class OpenCodeProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;

  private readonly options: ProviderOptions;
  private activeSessionId: string | undefined;

  constructor(options: ProviderOptions = {}) {
    this.options = options;
  }

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return STALE_SESSION_RE.test(msg);
  }

  query(input: QueryInput): AgentQuery {
    if (input.continuation) {
      this.activeSessionId = input.continuation;
    } else {
      this.activeSessionId = undefined;
    }

    const pending: string[] = [];
    let waiting: (() => void) | null = null;
    let ended = false;
    let aborted = false;

    const systemInstructions = input.systemContext?.instructions;
    pending.push(wrapPromptWithContext(input.prompt, systemInstructions));

    const kick = (): void => {
      waiting?.();
    };

    const self = this;
    const IDLE_TIMEOUT_MS = 90_000;

    async function* gen(): AsyncGenerator<ProviderEvent> {
      let initYielded = false;
      const rt = await ensureSharedRuntime(self.options);
      const { client, stream } = rt;

      while (!aborted) {
        while (pending.length === 0 && !ended && !aborted) {
          await new Promise<void>((resolve) => {
            waiting = resolve;
          });
          waiting = null;
        }

        if (aborted) return;
        if (pending.length === 0 && ended) return;

        const text = pending.shift()!;
        let sessionId = self.activeSessionId;

        if (!sessionId) {
          const created = await client.session.create();
          if (created.error) {
            throw new Error(`OpenCode: failed to create session: ${JSON.stringify(created.error)}`);
          }
          sessionId = created.data?.id;
          if (!sessionId) throw new Error('OpenCode: failed to create session (no id)');
          self.activeSessionId = sessionId;
        }

        if (!initYielded) {
          yield { type: 'init', continuation: sessionId };
          initYielded = true;
        }

        const promptRes = await client.session.promptAsync({
          path: { id: sessionId },
          body: { parts: [{ type: 'text', text }] },
        });
        if (promptRes.error) {
          self.activeSessionId = undefined;
          throw new Error(`OpenCode promptAsync: ${JSON.stringify(promptRes.error)}`);
        }

        const partTextByMessageId = new Map<string, string>();
        const roleByMessageId = new Map<string, string>();
        let lastEventAt = Date.now();
        let eventTimedOut = false;
        const timeoutCheck = setInterval(() => {
          if (Date.now() - lastEventAt > IDLE_TIMEOUT_MS) {
            log(`OpenCode event timeout (${IDLE_TIMEOUT_MS}ms) — clearing session ${sessionId}`);
            eventTimedOut = true;
            self.activeSessionId = undefined;
            destroySharedRuntime();
            kick();
          }
        }, 5000);

        try {
          turn: while (true) {
            if (aborted) return;
            if (eventTimedOut) {
              throw new Error(`OpenCode event timeout (${IDLE_TIMEOUT_MS}ms)`);
            }

            let next: IteratorResult<{ type: string; properties: Record<string, unknown> }, void>;
            try {
              next = await stream.next();
            } catch (err) {
              // The idle timer kills the server, which makes the in-flight
              // SSE read fail. Report the timeout — the real cause — rather
              // than the socket error it produced.
              if (eventTimedOut) throw new Error(`OpenCode event timeout (${IDLE_TIMEOUT_MS}ms)`);
              throw err;
            }
            const { value: ev, done } = next;
            if (done) {
              if (eventTimedOut) throw new Error(`OpenCode event timeout (${IDLE_TIMEOUT_MS}ms)`);
              throw new Error('OpenCode SSE stream ended unexpectedly');
            }

            if (!ev?.type || ev.type === 'server.connected' || ev.type === 'server.heartbeat') continue;

            lastEventAt = Date.now();
            yield { type: 'activity' };

            switch (ev.type) {
              case 'message.updated': {
                const info = ev.properties.info as { id?: string; role?: string } | undefined;
                if (info?.id && info?.role) {
                  roleByMessageId.set(info.id, info.role);
                }
                break;
              }
              case 'message.part.updated': {
                const part = ev.properties.part as { type?: string; messageID?: string; text?: string } | undefined;
                if (part?.type === 'text' && part.messageID && part.text) {
                  partTextByMessageId.set(part.messageID, part.text);
                }
                break;
              }
              case 'permission.updated': {
                const perm = ev.properties as { id?: string; sessionID?: string };
                if (perm.sessionID === sessionId && perm.id) {
                  try {
                    await client.postSessionIdPermissionsPermissionId({
                      path: { id: sessionId, permissionID: perm.id },
                      body: { response: 'always' },
                    });
                  } catch (err) {
                    log(`Failed to auto-reply permission: ${err instanceof Error ? err.message : String(err)}`);
                  }
                }
                break;
              }
              case 'session.status': {
                const props = ev.properties as {
                  sessionID?: string;
                  status?: { type?: string; attempt?: number; message?: string };
                };
                if (props.sessionID !== sessionId) break;
                const st = props.status;
                if (
                  st?.type === 'retry' &&
                  typeof st.attempt === 'number' &&
                  st.attempt >= SESSION_STATUS_RETRY_ERROR_AFTER &&
                  st.message
                ) {
                  self.activeSessionId = undefined;
                  throw new Error(`OpenCode retry limit (${st.attempt}): ${st.message}`);
                }
                break;
              }
              case 'session.error': {
                const props = ev.properties as { sessionID?: string; error?: unknown };
                if (props.sessionID === sessionId || props.sessionID === undefined) {
                  self.activeSessionId = undefined;
                  throw new Error(sessionErrorMessage(props));
                }
                break;
              }
              case 'session.idle': {
                const sid = (ev.properties as { sessionID?: string }).sessionID;
                if (sid === sessionId) {
                  break turn;
                }
                break;
              }
              default:
                break;
            }
          }
        } finally {
          clearInterval(timeoutCheck);
        }

        let resultText = '';
        for (const [msgId, role] of roleByMessageId) {
          if (role === 'assistant') {
            resultText = partTextByMessageId.get(msgId) ?? resultText;
          }
        }
        yield { type: 'result', text: resultText || null };
      }
    }

    return {
      push: (message: string) => {
        pending.push(wrapPromptWithContext(message, systemInstructions));
        kick();
      },
      end: () => {
        ended = true;
        kick();
      },
      events: gen(),
      abort: () => {
        aborted = true;
        this.activeSessionId = undefined;
        kick();
        destroySharedRuntime();
      },
    };
  }
}

registerProvider('opencode', (opts) => new OpenCodeProvider(opts));
