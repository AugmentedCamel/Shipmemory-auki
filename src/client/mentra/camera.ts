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
  console.log('[Mentra:camera] Starting managed livestream with WebRTC…');
  try {
    const result = await attemptStart(session);
    console.log('[Mentra:camera] Stream active:', JSON.stringify(result, null, 2));
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Only retry on timeout — other errors (auth, etc.) won't be fixed by
    // clearing a ghost stream. A timeout means Mentra cloud didn't respond,
    // usually because a prior session's stream is still stranded on Cloudflare.
    if (!/timeout/i.test(msg)) throw err;

    console.warn(`[Mentra:camera] Start failed (${msg}) — checking for ghost stream`);
    await clearGhostStream(session);

    console.log('[Mentra:camera] Retrying managed livestream…');
    const result = await attemptStart(session);
    console.log('[Mentra:camera] Stream active (after retry):', JSON.stringify(result, null, 2));
    return result;
  }
}

async function attemptStart(session: AppSession): Promise<LivestreamUrls> {
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

  const result = await session.camera.startManagedStream({
    enableWebRTC: true,
    quality: '720p',
  });

  await activeStatus;
  return result;
}

async function clearGhostStream(session: AppSession): Promise<void> {
  try {
    const existing = await session.camera.checkExistingStream();
    if (!existing.hasActiveStream) {
      console.log('[Mentra:camera] No ghost stream — ready to retry');
      return;
    }
    const info = existing.streamInfo;
    console.warn(`[Mentra:camera] Ghost stream found (id=${info?.streamId}, status=${info?.status}) — stopping`);
    await session.camera.stopManagedStream().catch((e) => {
      console.warn(`[Mentra:camera] Ghost stop errored (continuing): ${e instanceof Error ? e.message : e}`);
    });
    // Give Mentra cloud a moment to propagate the stop to Cloudflare before retry.
    await new Promise((r) => setTimeout(r, 2000));
  } catch (e) {
    console.warn(`[Mentra:camera] Ghost check failed (continuing): ${e instanceof Error ? e.message : e}`);
  }
}

export async function stopLivestream(session: AppSession): Promise<void> {
  try {
    await session.camera.stopManagedStream();
    console.log('[Mentra:camera] Livestream stopped');
  } catch {
    console.log('[Mentra:camera] Livestream stop skipped (session already closed)');
  }
}
