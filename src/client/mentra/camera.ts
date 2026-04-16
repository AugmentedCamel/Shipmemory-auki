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
 * Returns WebRTC + HLS/DASH URLs for consumption.
 *
 * Note: HLS/DASH return 404 on Cloudflare — only WebRTC (WHEP) and
 * the preview iframe are usable.
 */
export async function startLivestream(session: AppSession): Promise<LivestreamUrls> {
  console.log('[Mentra:camera] Starting managed livestream with WebRTC…');

  // Subscribe to status — previewUrl only appears in later status updates
  session.camera.onManagedStreamStatus((status) => {
    console.log(`[Mentra:camera] Stream status: ${status.status}`, status.streamId ?? '');

    const s = status as unknown as Record<string, unknown>;
    if (s.previewUrl && typeof s.previewUrl === 'string') {
      streamState.previewUrl = s.previewUrl;
      console.log(`[Mentra:camera] Preview URL captured: ${s.previewUrl}`);
    }
  });

  const result = await session.camera.startManagedStream({
    enableWebRTC: true,
    quality: '720p',
  });

  console.log('[Mentra:camera] Stream result:', JSON.stringify(result, null, 2));
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
