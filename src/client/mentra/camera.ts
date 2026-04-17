import type { AppSession } from '@mentra/sdk';
import { streamState } from '../index.js';

export interface LivestreamUrls {
  hlsUrl: string;
  dashUrl: string;
  webrtcUrl?: string;
  previewUrl?: string;
  streamId: string;
}

const GHOST_STREAM_WAIT_MS = 2000;

/**
 * Start a managed camera livestream via Mentra cloud.
 * Returns WebRTC + HLS/DASH URLs for consumption.
 *
 * Before starting, checks for any existing stream on this user (left over
 * from a prior session that got torn down without a clean stop) and kills
 * it. Prevents "Managed stream request timeout" on rapid app restarts.
 *
 * Note: HLS/DASH return 404 on Cloudflare — only WebRTC (WHEP) and
 * the preview iframe are usable.
 */
export async function startLivestream(session: AppSession): Promise<LivestreamUrls> {
  await clearGhostStream(session);

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

/**
 * Kill any ghost stream left from a prior session before allocating a new one.
 * The SDK's checkExistingStream() has a 5s internal timeout, so worst-case
 * this adds ~7s (5s check + 2s propagation) only when there's actually
 * a ghost; clean starts add 0–5s depending on how fast the check responds.
 */
async function clearGhostStream(session: AppSession): Promise<void> {
  try {
    const existing = await session.camera.checkExistingStream();
    if (!existing.hasActiveStream) {
      console.log('[Mentra:camera] No existing stream — starting fresh');
      return;
    }

    const info = existing.streamInfo;
    console.log(
      `[Mentra:camera] Ghost stream detected (id=${info?.streamId}, type=${info?.type}, ` +
      `status=${info?.status}) — stopping before restart`,
    );
    try {
      await session.camera.stopManagedStream();
    } catch (e) {
      console.warn(`[Mentra:camera] Ghost stop failed: ${e instanceof Error ? e.message : e}`);
    }

    // Give Mentra cloud time to propagate the stop to Cloudflare before we
    // ask it to allocate a new stream.
    await new Promise((r) => setTimeout(r, GHOST_STREAM_WAIT_MS));
  } catch (e) {
    console.warn(`[Mentra:camera] checkExistingStream failed, continuing anyway: ${e instanceof Error ? e.message : e}`);
  }
}
