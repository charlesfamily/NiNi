#!/usr/bin/env python3
"""Generate Nini Daily's notification chime (nini-chime.wav).

Why this exists: iOS custom notification sounds must be audio files inside
the app bundle, and the GitHub connector can only push UTF-8 text — so the
WAV is generated during the Codemagic build by this committed script and
bundled via the Xcode project's Resources phase.

Sound design: a warm "knock twice" chime. Two ascending C-major motifs
(C5 E5 G5 C6), struck like soft bells (sine + harmonics, exponential
decay), ~5.2 s total. Noticeable across a room, not a siren.

Usage: python3 scripts/make_chime.py [output-path]
Default output: ios/App/App/nini-chime.wav
"""
import math
import struct
import sys
import wave

SAMPLE_RATE = 44100
DURATION = 5.2

# (start_seconds, frequency_hz, gain)
NOTES = [
    # First motif — the knock.
    (0.00, 523.25, 0.90),   # C5
    (0.18, 659.25, 0.90),   # E5
    (0.36, 783.99, 0.95),   # G5
    (0.54, 1046.50, 1.00),  # C6
    # Second motif — the follow-through knock, a touch softer.
    (2.10, 523.25, 0.75),
    (2.28, 659.25, 0.75),
    (2.46, 783.99, 0.80),
    (2.64, 1046.50, 0.85),
]


def render():
    total = int(SAMPLE_RATE * DURATION)
    buf = [0.0] * total
    for start, freq, gain in NOTES:
        s0 = int(start * SAMPLE_RATE)
        # Each bell rings for up to ~2.2 s with exponential decay.
        ring = int(2.2 * SAMPLE_RATE)
        for i in range(ring):
            idx = s0 + i
            if idx >= total:
                break
            t = i / SAMPLE_RATE
            env = math.exp(-t * 2.6)
            # Fast, soft attack so it chimes instead of clicking.
            attack = min(1.0, t / 0.008)
            v = (
                math.sin(2 * math.pi * freq * t)
                + 0.45 * math.sin(2 * math.pi * freq * 2 * t)
                + 0.18 * math.sin(2 * math.pi * freq * 3 * t)
            )
            buf[idx] += gain * env * attack * v
    # Normalize to a confident but not clipping peak.
    peak = max(abs(x) for x in buf) or 1.0
    scale = 0.82 / peak
    return [max(-1.0, min(1.0, x * scale)) for x in buf]


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "ios/App/App/nini-chime.wav"
    samples = render()
    with wave.open(out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)  # 16-bit PCM — valid iOS notification sound format
        w.setframerate(SAMPLE_RATE)
        frames = b"".join(struct.pack("<h", int(x * 32767)) for x in samples)
        w.writeframes(frames)
    print(f"wrote {out}: {DURATION}s, {SAMPLE_RATE} Hz, mono, 16-bit")


if __name__ == "__main__":
    main()
