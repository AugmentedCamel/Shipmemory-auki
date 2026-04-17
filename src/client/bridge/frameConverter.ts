import { decode } from 'jpeg-js';
import type { Frame } from '../shipmemory/types.js';

/**
 * Decode a JPEG buffer into an RGBA Frame for jsQR.
 * Throws on corrupted/partial JPEG data — caller should catch and skip.
 */
export function jpegToFrame(jpeg: Buffer): Frame {
  const { data, width, height } = decode(jpeg, { formatAsRGBA: true });
  return {
    data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    width,
    height,
    jpeg,
  };
}

/**
 * Async-iterable queue that decouples a frame producer (WHEP loop) from a
 * consumer (ShipMemoryService.scan). The consumer always gets the latest
 * frame — stale frames are dropped. Calling stop() ends iteration.
 */
export class FrameRelay implements AsyncIterable<Frame> {
  private latest: Frame | null = null;
  private waiter: (() => void) | null = null;
  private stopped = false;

  push(frame: Frame): void {
    if (this.stopped) return;
    this.latest = frame;
    this.waiter?.();
    this.waiter = null;
  }

  stop(): void {
    this.stopped = true;
    this.waiter?.();
    this.waiter = null;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Frame> {
    while (!this.stopped) {
      if (this.latest) {
        const frame = this.latest;
        this.latest = null;
        yield frame;
      } else {
        await new Promise<void>((r) => { this.waiter = r; });
      }
    }
  }
}
