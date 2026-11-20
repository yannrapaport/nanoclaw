import { describe, expect, it } from 'vitest';

import { voiceNoteText } from './transcribe.js';

describe('voiceNoteText', () => {
  it('prefixes the transcript', () => {
    expect(voiceNoteText('quels sont mes mails ?')).toBe('🎤 (note vocale transcrite) quels sont mes mails ?');
  });

  it('says so when transcription failed', () => {
    expect(voiceNoteText(null)).toBe('🎤 (note vocale reçue — transcription impossible)');
  });

  it('keeps an accompanying caption', () => {
    expect(voiceNoteText('salut', 'légende')).toBe('🎤 (note vocale transcrite) salut\nlégende');
  });
});
