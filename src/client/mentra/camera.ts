import type { AppSession } from '@mentra/sdk';
import { streamState } from '../index.js';

export interface LivestreamUrls {
  hlsUrl: string;
  dashUrl: string;
  webrtcUrl?: string;
  previewUrl?: string;
  streamId: string;
}

/**
 * Start a managed camera livestream via Mentra cloud.
 *
 * Per Mentra docs, subscribe to status BEFORE calling start, then wait for
 * `status === 'active'` before using playback URLs. Using URLs during the
 * `initializing`/`preparing` phase produces flaky WHEP handshakes.
 *
 * Note: HLS/DASH return 404 on Cloudflare — only WebRTC (WHEP) and the
 * preview iframe are usable.
 */
export async function startLivestream(session: AppSession): Promise<LivestreamUrls> {
  const activeStatus = new Promise<void>((resolve, reject) => {
    const unsubscribe = session.camera.onManagedStreamStatus((status) => {
      console.log(`[Mentra:camera] Stream status: ${status.status}`, status.streamId ?? '');

      if (status.previewUrl) {
        streamState.previewUrl = status.previewUrl;
        console.log(`[Mentra:camera] Preview URL captured: ${status.previewUrl}`);
      }

      if (status.status === 'active') {
        unsubscribe();
        resolve();
      } else if (status.status === 'error') {
        unsubscribe();
        reject(new Error(`Managed stream error: ${status.message ?? 'unknown'}`));
      }
    });
  });

  console.log('[Mentra:camera] Starting managed livestream with WebRTC…');
  const result = await session.camera.startManagedStream({
    enableWebRTC: true,
    quality: '720p',
  });

  await activeStatus;

  console.log('[Mentra:camera] Stream active:', JSON.stringify(result, null, 2));
  return result;
}

export async function stopLivestream(session: AppSession): Promise<void> {
  try {
    await session.camera.stopManagedStream();
    console.log('[Mentra:camera] Livestream stopped');
  } catch {
    console.log('[Mentra:camera] Livestream stop skipped (session already closed)');
  }
}
