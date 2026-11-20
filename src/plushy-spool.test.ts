import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { buildCallPattern, plushySpoolHook, spoolRecordFor, type SpoolConfig } from './plushy-spool.js';
import type { InboundEvent } from './channels/adapter.js';

const STEERCO = '120363411985893507@g.us';

function ev(text: string, extra: Record<string, unknown> = {}, platformId = STEERCO): InboundEvent {
  return {
    channelType: 'whatsapp',
    platformId,
    threadId: null,
    message: {
      id: 'WAMID-1',
      kind: 'chat',
      content: JSON.stringify({ text, sender: '243202640625713@lid', senderName: 'Alex R', ...extra }),
      timestamp: '2026-11-20T10:00:00.000Z',
    },
  };
}

const cfg = (dir = '/nonexistent'): SpoolConfig => ({ groups: new Set([STEERCO]), dir });
const pat = buildCallPattern('IAnn');

describe('buildCallPattern', () => {
  it.each([
    '@Plushy peux-tu me dire…',
    'Bonjour @plushy, une question',
    '@IAnn regarde ça',
    'hello @271142006857729 tu peux',
    '@33749242902 stp',
  ])('matches a call: %s', (t) => expect(pat.test(t)).toBe(true));

  it.each([
    'Plushy est super',
    'voir le @Plushyboard',
    'écris à plushy@la-pelucherie.com',
    'contact: x@plushy',
    '',
  ])('ignores: %s', (t) => expect(pat.test(t)).toBe(false));
});

describe('spoolRecordFor', () => {
  it('spools a call in a listed group, with sender and message id', () => {
    const r = spoolRecordFor(ev('@Plushy où en est la NL ?'), cfg(), pat, new Date('2026-11-20T10:00:01Z'));
    expect(r).toMatchObject({
      v: 1,
      platformId: STEERCO,
      messageId: 'WAMID-1',
      sender: '243202640625713@lid',
      senderName: 'Alex R',
      text: '@Plushy où en est la NL ?',
      forwarded: false,
    });
  });

  it('ignores a message without a call', () => {
    expect(spoolRecordFor(ev('on se voit demain'), cfg(), pat)).toBeNull();
  });

  it('ignores a group that is not listed', () => {
    expect(spoolRecordFor(ev('@Plushy hello', {}, 'other@g.us'), cfg(), pat)).toBeNull();
  });

  it('ignores another channel type', () => {
    const e = { ...ev('@Plushy hello'), channelType: 'telegram' };
    expect(spoolRecordFor(e, cfg(), pat)).toBeNull();
  });

  it('ignores our own messages', () => {
    expect(spoolRecordFor(ev('@Plushy', { fromMe: true }), cfg(), pat)).toBeNull();
  });

  it('flags a forwarded message', () => {
    expect(spoolRecordFor(ev('@Plushy fais X', { isForwarded: true }), cfg(), pat)?.forwarded).toBe(true);
  });
});

describe('plushySpoolHook', () => {
  it('writes one JSON file in new/, nothing left in tmp/', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plushy-spool-'));
    expect(plushySpoolHook(ev('@Plushy test'), cfg(dir))).toBe(true);
    const files = fs.readdirSync(path.join(dir, 'new'));
    expect(files).toHaveLength(1);
    expect(fs.readdirSync(path.join(dir, 'tmp'))).toHaveLength(0);
    const rec = JSON.parse(fs.readFileSync(path.join(dir, 'new', files[0]), 'utf8'));
    expect(rec.text).toBe('@Plushy test');
    fs.rmSync(dir, { recursive: true });
  });

  it('writes nothing for chatter', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plushy-spool-'));
    expect(plushySpoolHook(ev('bonjour à tous'), cfg(dir))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'new'))).toBe(false);
    fs.rmSync(dir, { recursive: true });
  });

  it('is inert without groups', () => {
    expect(plushySpoolHook(ev('@Plushy test'), { groups: new Set(), dir: '/nonexistent' })).toBe(false);
  });

  it('never throws when the spool path is not a directory', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'plushy-spool-')), 'a-file');
    fs.writeFileSync(file, 'x');
    expect(plushySpoolHook(ev('@Plushy test'), cfg(file))).toBe(false);
    fs.rmSync(path.dirname(file), { recursive: true });
  });
});
