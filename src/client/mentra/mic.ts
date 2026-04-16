import type { AppSession } from '@mentra/sdk';

export type AudioChunkHandler = (pcm: ArrayBufferLike, sampleRate: number) => void;

/**
 * Subscribes to raw mic audio from Mentra glasses.
 * PCM 16kHz mono — pipe directly to Gemini Live.
 */
export function subscribeMic(session: AppSession, handler: AudioChunkHandler): void {
  let chunkCount = 0;
  let totalBytes = 0;
  let lastLogTime = Date.now();

  session.events.onAudioChunk((chunk) => {
    chunkCount++;
    totalBytes += chunk.arrayBuffer.byteLength;

    // Log every 5 seconds
    const now = Date.now();
    if (now - lastLogTime >= 5000) {
      console.log(`[Mentra:mic] ${chunkCount} chunks received, ${(totalBytes / 1024).toFixed(1)}KB total, rate=${chunk.sampleRate ?? 16000}Hz`);
      lastLogTime = now;
    }

    handler(chunk.arrayBuffer, chunk.sampleRate ?? 16000);
  });
  console.log('[Mentra:mic] Subscribed to audio chunks');
}
