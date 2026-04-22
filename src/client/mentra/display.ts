import type { AppSession } from '@mentra/sdk';

/** Show a text overlay on the glasses display. */
export function showText(session: AppSession, text: string, durationMs = 3000): void {
  session.layouts.showTextWall(text, { durationMs });
}
