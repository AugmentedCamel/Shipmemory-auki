/**
 * Encode raw PCM bytes to base64 for Gemini WebSocket transport.
 */
export function pcmToBase64(pcm: ArrayBufferLike): string {
  const bytes = new Uint8Array(pcm);
  return Buffer.from(bytes).toString('base64');
}

/**
 * Decode base64 audio from Gemini response to raw PCM bytes.
 */
export function base64ToPcm(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

/**
 * Encode a JPEG buffer to base64 for Gemini video input.
 */
export function jpegToBase64(jpeg: Buffer): string {
  return jpeg.toString('base64');
}
