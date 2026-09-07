import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import './opencode.js';
import { getProviderContainerConfig } from './provider-container-registry.js';

describe('opencode provider container config', () => {
  let sessionDir: string;
  beforeEach(() => {
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-test-'));
  });
  afterEach(() => {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  });

  it('passes OPENCODE_MODEL through from the host env by default', () => {
    const fn = getProviderContainerConfig('opencode')!;
    const { env } = fn({
      sessionDir,
      agentGroupId: 'ag-test',
      hostEnv: { OPENCODE_MODEL: 'anthropic/claude-haiku-4-5-20251001' },
    });
    expect(env?.OPENCODE_MODEL).toBe('anthropic/claude-haiku-4-5-20251001');
  });

  it('lets a per-group model override the host env', () => {
    const fn = getProviderContainerConfig('opencode')!;
    const { env } = fn({
      sessionDir,
      agentGroupId: 'ag-test',
      hostEnv: { OPENCODE_MODEL: 'anthropic/claude-haiku-4-5-20251001' },
      model: 'anthropic/claude-sonnet-4-5-20250929',
    });
    expect(env?.OPENCODE_MODEL).toBe('anthropic/claude-sonnet-4-5-20250929');
  });
});
