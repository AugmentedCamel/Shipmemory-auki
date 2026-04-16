import type { AppSession } from '@mentra/sdk';

export interface CameraStream {
  /** RTMP URL where the camera is streaming to */
  rtmpUrl: string;
}

/**
 * Starts the Mentra glasses camera stream.
 * Returns the stream URL for consumption by the WHEP/frame bridge.
 */
export async function startCameraStream(
  session: AppSession,
  rtmpUrl: string,
): Promise<CameraStream> {
  await session.camera.startStream({ rtmpUrl });
  console.log(`[Mentra:camera] Stream started → ${rtmpUrl}`);
  return { rtmpUrl };
}

export async function stopCameraStream(session: AppSession): Promise<void> {
  await session.camera.stopStream();
  console.log('[Mentra:camera] Stream stopped');
}
