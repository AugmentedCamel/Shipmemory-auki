import type { AppSession } from '@mentra/sdk';

/**
 * Speaks text through the Mentra glasses TTS engine.
 * Used as the audio output path: Gemini outputTranscription → TTS → glasses speakers.
 */
export async function speak(session: AppSession, text: string): Promise<void> {
  if (!text.trim()) return;
  try {
    await session.audio.speak(text);
  } catch (err) {
    console.error('[Mentra:display] TTS failed:', err);
  }
}

/** Show a text overlay on the glasses display. */
export function showText(session: AppSession, text: string, durationMs = 3000): void {
  session.layouts.showTextWall(text, { durationMs });
}
