import jsQR from 'jsqr';
import type { Frame } from './types.js';

/**
 * Attempt to decode a QR code from an RGBA frame buffer.
 * Returns the raw QR string, or null if no QR found.
 */
export function decodeQR(frame: Frame): string | null {
  const clamped = new Uint8ClampedArray(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);
  const result = jsQR(clamped, frame.width, frame.height);
  return result?.data ?? null;
}
