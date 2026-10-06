/**
 * Persona drafting — pure functions, no DB and no I/O beyond reading a
 * persona file.
 *
 * A persona is what the bot is called and how it behaves in ONE group. The
 * owner describes it in a DM, either by naming a file that already exists in
 * the personas directory (`artus` → `<dir>/artus.md`) or in free text
 * (`Raymond, réincarnation de Poulidor, conseils vélo`).
 */
import fs from 'fs';
import path from 'path';

export interface PersonaDraft {
  /** Display name, also the word members use to address the bot. */
  name: string;
  /** Extra words that wake the persona (nicknames). */
  aliases: string[];
  /** Content of the group's CLAUDE.local.md. */
  personaMd: string;
  /** Text posted once in the group when the persona goes live. */
  intro: string;
  unknownSenderPolicy: 'public' | 'strict';
  /** Skip the owner's preview of the intro. */
  direct: boolean;
}

export type OwnerReply =
  | { kind: 'ignore' }
  | { kind: 'ok' }
  | { kind: 'file'; slug: string; strict: boolean; direct: boolean }
  | { kind: 'text'; name: string; description: string; strict: boolean; direct: boolean }
  | { kind: 'unparsed' };

const WORD_CHARS = 'A-Za-zÀ-ÖØ-öø-ÿ0-9_';
const FLAGS = new Set(['strict', 'direct']);

/**
 * Read the owner's answer to "which persona?".
 *
 * Trailing `strict` / `direct` segments are options, not part of the persona.
 * One bare word names a persona file; `Name, description` is free text.
 */
export function parseOwnerReply(raw: string): OwnerReply {
  const text = raw.trim();
  if (!text) return { kind: 'unparsed' };
  const lower = text.toLowerCase();
  if (lower === 'ignore') return { kind: 'ignore' };
  if (lower === 'ok') return { kind: 'ok' };

  const segments = text.split(',').map((s) => s.trim());
  let strict = false;
  let direct = false;
  while (segments.length > 1 && FLAGS.has(segments[segments.length - 1].toLowerCase())) {
    const flag = segments.pop()!.toLowerCase();
    if (flag === 'strict') strict = true;
    if (flag === 'direct') direct = true;
  }

  if (segments.length === 1 && /^[\p{L}\p{N}_-]+$/u.test(segments[0])) {
    return { kind: 'file', slug: segments[0].toLowerCase(), strict, direct };
  }

  const name = segments[0];
  const description = segments.slice(1).join(', ').trim();
  if (!name || name.length > 30 || !description) return { kind: 'unparsed' };
  return { kind: 'text', name, description, strict, direct };
}

/** Folder-safe slug: `Berthelot Alumni 🚴` → `berthelot-alumni`. */
export function slugify(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Regex source for `messaging_group_agents.engage_pattern`.
 *
 * The router compiles it with no flags (`new RegExp(pat)`), so case
 * insensitivity is spelled out per letter (`[Aa]rtus`), and the word
 * boundary is a lookaround over an explicit class: `\b` treats accented
 * letters as non-word, which would let « Hélène » match inside « Hélènes ».
 */
export function buildEngagePattern(names: string[], assistantName: string): string {
  const alternatives = names
    .map((n) => n.trim())
    .filter(Boolean)
    .map((n) => {
      const body = [...n]
        .map((ch) => {
          const lo = ch.toLowerCase();
          const up = ch.toUpperCase();
          if (lo !== up) return `[${up}${lo}]`;
          return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        })
        .join('');
      return `(?<![${WORD_CHARS}])${body}(?![${WORD_CHARS}])`;
    });
  // The adapter rewrites a platform mention of the bot to `@<assistant name>`.
  alternatives.push(`@${assistantName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
  return alternatives.join('|');
}

/** List the persona files the owner can name (`artus.md` → `artus`). */
export function listPersonaFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md') && !f.startsWith('.') && f.toLowerCase() !== 'readme.md')
    .map((f) => f.slice(0, -3).toLowerCase())
    .sort();
}

/**
 * Load `<dir>/<slug>.md`. Conventions read from the file:
 *   - the first `# Heading` is the persona's name;
 *   - an optional `Alias : A, B` line adds wake words;
 *   - the section whose heading contains « présentation » holds the intro:
 *     its first paragraph is the instruction to the agent, the rest is the
 *     text to post.
 * Returns null when the file is missing or has no name.
 */
export function loadPersonaFile(
  dir: string,
  slug: string,
): Pick<PersonaDraft, 'name' | 'aliases' | 'personaMd' | 'intro'> | null {
  const file = path.join(dir, `${slug}.md`);
  // The slug comes from a chat message: never let it leave the directory.
  if (path.dirname(path.resolve(file)) !== path.resolve(dir) || !fs.existsSync(file)) return null;
  const personaMd = fs.readFileSync(file, 'utf-8');

  const name = personaMd.match(/^#\s+(.+)$/m)?.[1].trim();
  if (!name) return null;

  const aliasLine = personaMd.match(/^\s*(?:\*\*)?alias(?:es)?(?:\*\*)?\s*:\s*(.+)$/im)?.[1] ?? '';
  const aliases = aliasLine
    .split(',')
    .map((a) => a.replace(/[*_`.]/g, '').trim())
    .filter(Boolean);

  return { name, aliases, personaMd, intro: extractIntro(personaMd) ?? defaultIntro(name, '') };
}

function extractIntro(personaMd: string): string | null {
  const lines = personaMd.split('\n');
  const start = lines.findIndex((l) => /^#{2,}\s.*pr[ée]sentation/i.test(l));
  if (start === -1) return null;
  let end = lines.findIndex((l, i) => i > start && /^#{1,6}\s/.test(l));
  if (end === -1) end = lines.length;
  const paragraphs = lines
    .slice(start + 1, end)
    .join('\n')
    .trim()
    .split(/\n\s*\n/);
  if (paragraphs.length < 2) return null;
  const intro = paragraphs.slice(1).join('\n\n').trim();
  return intro || null;
}

function defaultIntro(name: string, description: string): string {
  const what = description ? ` : ${description}` : '';
  return (
    `Bonjour, je suis *${name}*${what}. Je suis une IA.\n` +
    `Pour me parler, mettez *${name}* dans votre message. Sinon je ne dis rien.`
  );
}

/** Persona from the owner's free text, dropped as-is into a fixed frame. */
export function personaFromText(
  name: string,
  description: string,
  groupName: string,
): Pick<PersonaDraft, 'name' | 'aliases' | 'personaMd' | 'intro'> {
  const intro = defaultIntro(name, description);
  const personaMd = [
    `# ${name}`,
    '',
    `Tu es **${name}**, une persona de l'assistant dans le groupe WhatsApp « ${groupName} ».`,
    'Tu es une IA et tu le dis si on te le demande.',
    '',
    '## Qui tu es',
    '',
    description,
    '',
    '## Comment tu réponds',
    '',
    '- Court, au format WhatsApp : une à quatre phrases, pas de titres ni de listes.',
    '- Tu restes dans ton personnage et dans ton domaine.',
    '',
    '## Quand tu parles, quand tu te tais',
    '',
    `Tu n'es réveillé que si quelqu'un écrit « ${name} » ou te mentionne avec @.`,
    "Si le message ne s'adresse pas à toi ou si tu n'as rien d'utile à dire, tu te tais : mets tout",
    'ton texte dans des balises `<internal>...</internal>`. Un message entièrement en `<internal>`',
    "n'est jamais envoyé.",
    '',
    '## Ta présentation',
    '',
    'Quand on te demande de te présenter, envoie exactement ce texte, sans rien ajouter :',
    '',
    intro,
    '',
  ].join('\n');
  return { name, aliases: [], personaMd, intro };
}
