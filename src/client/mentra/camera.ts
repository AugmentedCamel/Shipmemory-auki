import type { AppSession } from '@mentra/sdk';
import { streamState } from '../index.js';

export interface LivestreamUrls {
  hlsUrl: string;
  dashUrl: string;
  webrtcUrl?: string;
  previewUrl?: string;
  streamId: string;
}

export type StreamStatusEvent =
  | { type: 'active'; streamId?: string; previewUrl?: string }
  | { type: 'stopped'; streamId?: string }
  | { type: 'error'; streamId?: string; message?: string };

export interface LivestreamResult extends LivestreamUrls {
  /** Call to stop receiving post-startup status events. */
  unsubscribeStatus: () => void;
}

/**
 * Start a managed camera livestream via Mentra cloud.
 *
 * Per Mentra docs, subscribe to status BEFORE calling start, then wait for
 * `status === 'active'` before using playback URLs. Using URLs during the
 * `initializing`/`preparing` phase produces flaky WHEP handshakes.
 *
 * After the stream reaches `active`, a persistent listener keeps running and
 * forwards subsequent status events to `onStatusChange`. This is how we detect
 * post-startup errors (Mentra #2526 / Cloudflare drops) that previously went
 * unnoticed because the one-shot subscription was unsubscribed at `active`.
 *
 * Note: HLS/DASH return 404 on Cloudflare — only WebRTC (WHEP) and the
 * preview iframe are usable.
 */
export async function startLivestream(
  session: AppSession,
  onStatusChange?: (event: StreamStatusEvent) => void,
): Promise<LivestreamResult> {
  console.log('[Mentra:camera] Starting managed livestream with WebRTC…');
  try {
    return await attemptStart(session, onStatusChange);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Only retry on timeout — other errors (auth, etc.) won't be fixed by
    // clearing a ghost stream. A timeout means Mentra cloud didn't respond,
    // usually because a prior session's stream is still stranded on Cloudflare.
    if (!/timeout/i.test(msg)) throw err;

    console.warn(`[Mentra:camera] Start failed (${msg}) — checking for ghost stream`);
    await clearGhostStream(session);

    console.log('[Mentra:camera] Retrying managed livestream…');
    return await attemptStart(session, onStatusChange);
  }
}

async function attemptStart(
  session: AppSession,
  onStatusChange?: (event: StreamStatusEvent) => void,
): Promise<LivestreamResult> {
  let activeStreamId: string | undefined;

  const activeStatus = new Promise<void>((resolve, reject) => {
    const unsubscribe = session.camera.onManagedStreamStatus((status) => {
      console.log(`[Mentra:camera] Stream status: ${status.status}`, status.streamId ?? '');

      if (status.previewUrl) {
        streamState.previewUrl = status.previewUrl;
        console.log(`[Mentra:camera] Preview URL captured: ${status.previewUrl}`);
      }

      if (status.status === 'active') {
        activeStreamId = status.streamId;
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
  console.log('[Mentra:camera] Stream active:', JSON.stringify(result, null, 2));

  // Post-startup listener — fires for every subsequent status change for the
  // lifetime of this stream. Caller is responsible for calling unsubscribeStatus
  // on teardown (or when restarting, so the new stream's listener takes over).
  const unsubscribeStatus = session.camera.onManagedStreamStatus((status) => {
    // Ignore late events for streamIds other than the one we just activated.
    // Without this, a stopped/error from the previous stream can trigger our
    // error handler during a restart.
    if (status.streamId && activeStreamId && status.streamId !== activeStreamId) return;

    if (status.previewUrl) streamState.previewUrl = status.previewUrl;

    if (status.status === 'active') {
      console.log(`[Mentra:camera] Post-startup status: active ${status.streamId ?? ''}`);
      onStatusChange?.({ type: 'active', streamId: status.streamId, previewUrl: status.previewUrl });
    } else if (status.status === 'error') {
      console.warn(`[Mentra:camera] Post-startup status: error ${status.streamId ?? ''} — ${status.message ?? 'no message'}`);
      onStatusChange?.({ type: 'error', streamId: status.streamId, message: status.message });
    } else if (status.status === 'stopped') {
      console.log(`[Mentra:camera] Post-startup status: stopped ${status.streamId ?? ''}`);
      onStatusChange?.({ type: 'stopped', streamId: status.streamId });
    }
  });

  return { ...result, unsubscribeStatus };
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
