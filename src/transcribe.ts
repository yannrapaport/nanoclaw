/**
 * Transcription locale des notes vocales (faster-whisper sur l'hôte, via uv).
 *
 * Rien ne sort de la machine. Coût mesuré sur Nexus (2 vCPU) : ~4 s de chargement
 * du modèle + ~4 s par seconde d'audio courte, ~640 Mo de RAM pendant l'appel.
 */
import { execFile } from 'child_process';
import os from 'os';
import path from 'path';

import { log } from './log.js';

const SCRIPT = path.join(process.cwd(), 'scripts', 'transcribe.py');
const UV = process.env.UV_BIN || path.join(os.homedir(), '.local', 'bin', 'uv');
const TIMEOUT_MS = 180_000;

/** Texte vu par l'agent pour une note vocale : la transcription, ou l'échec dit tel quel. */
export function voiceNoteText(transcript: string | null, caption = ''): string {
  const head = transcript
    ? `🎤 (note vocale transcrite) ${transcript}`
    : '🎤 (note vocale reçue — transcription impossible)';
  return caption ? `${head}\n${caption}` : head;
}

/** Renvoie le texte transcrit, ou null si la transcription échoue ou ne donne rien. */
export function transcribeAudio(absPath: string): Promise<string | null> {
  const started = Date.now();
  return new Promise((resolve) => {
    execFile(UV, ['run', '--quiet', SCRIPT, absPath], { timeout: TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err) {
        log.warn('Voice transcription failed', {
          file: path.basename(absPath),
          err: err.message,
          stderr: stderr?.slice(-500),
        });
        resolve(null);
        return;
      }
      const text = stdout.trim();
      log.info('Voice note transcribed', {
        file: path.basename(absPath),
        ms: Date.now() - started,
        chars: text.length,
      });
      resolve(text || null);
    });
  });
}
