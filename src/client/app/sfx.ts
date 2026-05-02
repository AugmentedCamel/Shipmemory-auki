import type { AppSession } from '@mentra/sdk';
import { env } from '../config/env.js';

export type SfxName = 'scanning' | 'found' | 'session-end';

/**
 * Fire-and-forget sound effect. The Mentra SDK's playAudio downloads the
 * file from a URL — we host the MP3s on this same client process under
 * /sfx/<name>.mp3 (see src/client/index.ts). Self-contained: no bridge
 * dependency. No-op when MENTRA_PUBLIC_URL is unset.
 */
export function playSfx(session: AppSession, name: SfxName, volume = 0.7): void {
  if (!env.MENTRA_PUBLIC_URL) return;
  const audioUrl = `${env.MENTRA_PUBLIC_URL.replace(/\/$/, '')}/sfx/${name}.mp3`;
  session.audio.playAudio({ audioUrl, volume }).catch((err) => {
    console.warn(`[SFX] ${name} failed:`, err);
  });
}
