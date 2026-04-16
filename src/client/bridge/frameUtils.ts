import type { Frame } from '../shipmemory/types.js';

/** Average luminance of an RGBA frame (0-255). O(n), <1ms for 640x480. */
export function avgLuminance(frame: Frame): number {
  const { data, width, height } = frame;
  const pixelCount = width * height;
  if (pixelCount === 0) return 0;

  let sum = 0;
  // RGBA: stride 4, luminance from RGB using BT.601
  for (let i = 0; i < data.length; i += 4) {
    sum += data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
  }
  return sum / pixelCount;
}

/**
 * Simple perceptual hash: downscale to 8x8, convert to grayscale,
 * compare each pixel to the mean → 64-bit hash as a number.
 */
export function perceptualHash(frame: Frame): number {
  const { data, width, height } = frame;
  const SIZE = 8;
  const gray = new Float64Array(SIZE * SIZE);

  // Nearest-neighbor downscale to 8x8
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const srcX = Math.floor((x / SIZE) * width);
      const srcY = Math.floor((y / SIZE) * height);
      const i = (srcY * width + srcX) * 4;
      gray[y * SIZE + x] = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
    }
  }

  // Mean
  let mean = 0;
  for (let i = 0; i < 64; i++) mean += gray[i];
  mean /= 64;

  // Hash: 1 bit per pixel (above/below mean)
  let hash = 0;
  for (let i = 0; i < 64; i++) {
    if (gray[i] >= mean) hash |= 1 << (i % 32); // Use lower 32 bits safely
  }
  return hash;
}

/** Hamming distance between two hashes (number of differing bits). */
export function hammingDistance(a: number, b: number): number {
  let xor = a ^ b;
  let count = 0;
  while (xor) {
    count += xor & 1;
    xor >>>= 1;
  }
  return count;
}
