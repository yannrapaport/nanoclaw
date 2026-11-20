# /// script
# requires-python = ">=3.10"
# dependencies = ["faster-whisper", "numpy"]
# ///
"""Transcrit un fichier audio en local (faster-whisper, CPU) et imprime le texte sur stdout.

Appelé par src/transcribe.ts pour les notes vocales WhatsApp. Le décodage passe par
ffmpeg : le PyAV embarqué par faster-whisper casse sur certaines versions.

  uv run scripts/transcribe.py <fichier>
Env : WHISPER_MODEL (défaut small), WHISPER_LANG (défaut : détection auto).
"""
import os
import subprocess
import sys

import numpy as np
from faster_whisper import WhisperModel


def main() -> int:
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", sys.argv[1], "-f", "f32le", "-ac", "1", "-ar", "16000", "-"],
        capture_output=True,
        check=True,
    ).stdout
    audio = np.frombuffer(raw, np.float32)
    model = WhisperModel(os.environ.get("WHISPER_MODEL", "small"), device="cpu", compute_type="int8", cpu_threads=2)
    segments, _ = model.transcribe(audio, language=os.environ.get("WHISPER_LANG") or None, vad_filter=True)
    print(" ".join(s.text.strip() for s in segments).strip())
    return 0


if __name__ == "__main__":
    sys.exit(main())
