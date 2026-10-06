import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildEngagePattern,
  listPersonaFiles,
  loadPersonaFile,
  parseOwnerReply,
  personaFromText,
  slugify,
} from './persona.js';

describe('parseOwnerReply', () => {
  it('reads the control words', () => {
    expect(parseOwnerReply(' Ignore ')).toEqual({ kind: 'ignore' });
    expect(parseOwnerReply('OK')).toEqual({ kind: 'ok' });
    expect(parseOwnerReply('   ')).toEqual({ kind: 'unparsed' });
  });

  it('reads one bare word as a persona file', () => {
    expect(parseOwnerReply('Raymond')).toEqual({ kind: 'file', slug: 'raymond', strict: false, direct: false });
  });

  it('reads « Name, description » as free text', () => {
    expect(parseOwnerReply('Raymond, réincarnation de Poulidor, conseils vélo')).toEqual({
      kind: 'text',
      name: 'Raymond',
      description: 'réincarnation de Poulidor, conseils vélo',
      strict: false,
      direct: false,
    });
  });

  it('takes trailing strict / direct as options, not as description', () => {
    expect(parseOwnerReply('artus, direct')).toEqual({ kind: 'file', slug: 'artus', strict: false, direct: true });
    expect(parseOwnerReply('Léa, coach de course, strict, direct')).toEqual({
      kind: 'text',
      name: 'Léa',
      description: 'coach de course',
      strict: true,
      direct: true,
    });
  });

  it('refuses a sentence with no name to hang on', () => {
    expect(parseOwnerReply('fais comme tu veux mon grand')).toEqual({ kind: 'unparsed' });
  });
});

describe('buildEngagePattern', () => {
  // The router compiles the pattern with no flags.
  const test = (pattern: string, text: string) => new RegExp(pattern).test(text);

  it('matches the name in any case, and the rewritten mention', () => {
    const p = buildEngagePattern(['Artus'], 'IAnn');
    expect(test(p, 'artus fais nous rire')).toBe(true);
    expect(test(p, 'Hé ARTUS !')).toBe(true);
    expect(test(p, '@IAnn tu es là ?')).toBe(true);
    expect(test(p, 'on mange quoi ce soir')).toBe(false);
  });

  it('does not match inside a longer word, accents included', () => {
    const p = buildEngagePattern(['Hélène'], 'IAnn');
    expect(test(p, 'hélène, une idée ?')).toBe(true);
    expect(test(p, 'les Hélènes du monde')).toBe(false);
    expect(test(buildEngagePattern(['Léa'], 'IAnn'), 'Léandre arrive')).toBe(false);
  });

  it('wakes on aliases too', () => {
    const p = buildEngagePattern(['Raymond', 'Poupou'], 'IAnn');
    expect(test(p, 'allez poupou')).toBe(true);
  });
});

describe('slugify', () => {
  it('makes a folder-safe label', () => {
    expect(slugify('Berthelot Alumni 🚴')).toBe('berthelot-alumni');
    expect(slugify('Opération Summer body 👙')).toBe('operation-summer-body');
  });
});

describe('persona files', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'personas-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true });
  });

  it('reads name, aliases and the intro to post', () => {
    fs.writeFileSync(
      path.join(dir, 'raymond.md'),
      [
        '# Raymond',
        '',
        'Alias : Poupou',
        '',
        '## Ton registre',
        '',
        'Bonhomme.',
        '',
        '## Ta présentation',
        '',
        'Quand on te demande de te présenter, envoie exactement ce texte :',
        '',
        'Salut la compagnie, c’est Raymond.',
        'Mettez *Raymond* dans votre message.',
        '',
      ].join('\n'),
    );
    const persona = loadPersonaFile(dir, 'raymond');
    expect(persona?.name).toBe('Raymond');
    expect(persona?.aliases).toEqual(['Poupou']);
    expect(persona?.intro).toBe('Salut la compagnie, c’est Raymond.\nMettez *Raymond* dans votre message.');
    expect(listPersonaFiles(dir)).toEqual(['raymond']);
  });

  it('falls back to a default intro when the file has none', () => {
    fs.writeFileSync(path.join(dir, 'lea.md'), '# Léa\n\nCoach.\n');
    expect(loadPersonaFile(dir, 'lea')?.intro).toContain('*Léa*');
  });

  it('returns null for a missing file and never leaves the directory', () => {
    expect(loadPersonaFile(dir, 'nope')).toBeNull();
    fs.writeFileSync(path.join(dir, '..', 'outside-persona.md'), '# Outside\n');
    try {
      expect(loadPersonaFile(dir, '../outside-persona')).toBeNull();
    } finally {
      fs.rmSync(path.join(dir, '..', 'outside-persona.md'));
    }
  });
});

describe('personaFromText', () => {
  it('frames the description and embeds the intro it announces', () => {
    const persona = personaFromText('Raymond', 'réincarnation de Poulidor', 'Berthelot Alumni');
    expect(persona.personaMd).toContain('# Raymond');
    expect(persona.personaMd).toContain('réincarnation de Poulidor');
    expect(persona.personaMd).toContain(persona.intro);
    expect(persona.intro).toContain('*Raymond*');
  });
});
