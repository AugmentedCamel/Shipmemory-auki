import type { AppSession } from '@mentra/sdk';

export type AudioChunkHandler = (pcm: ArrayBufferLike, sampleRate: number) => void;

const GAP_THRESHOLD_MS = 1500;

/**
 * Subscribes to raw mic audio from Mentra glasses.
 * PCM 16kHz mono — pipe directly to Gemini Live.
 *
 * Also subscribes to the device VAD stream so we can tell whether the
 * glasses THINK the user is speaking independent of whether chunks are
 * actually being delivered to us.
 */
export function subscribeMic(session: AppSession, handler: AudioChunkHandler): void {
  let chunkCount = 0;
  let totalBytes = 0;
  let lastChunkTime = 0;
  let streakStart = 0;
  let streakBytes = 0;
  let streakChunks = 0;
  let gapTimer: ReturnType<typeof setTimeout> | null = null;

  const emitGap = () => {
    if (!lastChunkTime) return;
    const age = Date.now() - lastChunkTime;
    const streakMs = lastChunkTime - streakStart;
    console.log(
      `[Mentra:mic] GAP — no chunk for ${age}ms (prior streak: ${streakMs}ms, ${streakChunks} chunks, ${(streakBytes / 1024).toFixed(1)}KB)`,
    );
    streakStart = 0;
    streakBytes = 0;
    streakChunks = 0;
    gapTimer = null;
  };

  session.events.onAudioChunk((chunk) => {
    const now = Date.now();
    const bytes = chunk.arrayBuffer.byteLength;
    chunkCount++;
    totalBytes += bytes;

    // New streak? log the START
    if (!streakStart || (now - lastChunkTime) > GAP_THRESHOLD_MS) {
      const silenceMs = lastChunkTime ? now - lastChunkTime : 0;
      console.log(
        `[Mentra:mic] START — first chunk ${silenceMs ? `after ${silenceMs}ms silence` : '(session start)'} (rate=${chunk.sampleRate ?? 16000}Hz, ${bytes}B)`,
      );
      streakStart = now;
      streakBytes = 0;
      streakChunks = 0;
    }

    streakBytes += bytes;
    streakChunks++;
    lastChunkTime = now;

    // Reset gap watchdog
    if (gapTimer) clearTimeout(gapTimer);
    gapTimer = setTimeout(emitGap, GAP_THRESHOLD_MS);

    handler(chunk.arrayBuffer, chunk.sampleRate ?? 16000);
  });

  // Device-side VAD. Fires independently of audio_chunk delivery — if VAD
  // says "speaking" but chunks aren't arriving, the glasses firmware is
  // gating us (e.g. during AI playback).
  session.events.onVoiceActivity((vad) => {
    const status = typeof vad.status === 'string' ? vad.status : String(vad.status);
    console.log(`[Mentra:vad] status=${status}`);
  });

  console.log('[Mentra:mic] Subscribed to audio chunks + VAD');
}
