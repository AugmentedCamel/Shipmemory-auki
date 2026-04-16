import { spawn, type ChildProcess } from 'child_process';
import type { Frame } from '../shipmemory/types.js';

/**
 * Consumes an RTMP (or future WHEP) stream and extracts raw RGBA frames
 * via FFmpeg subprocess.
 *
 * Current approach: FFmpeg reads the stream URL and outputs raw RGBA pixels
 * to stdout. We parse fixed-size frame chunks from the pipe.
 *
 * When the Mentra SDK adds WHEP/WebRTC support, this can be swapped to
 * use werift for direct WebRTC consumption without changing the frame
 * consumer interface.
 */
export class StreamFrameExtractor {
  private ffmpeg: ChildProcess | null = null;
  private buffer = Buffer.alloc(0);
  private frameSize = 0;
  private running = false;

  constructor(
    private width = 640,
    private height = 480,
    private fps = 30,
  ) {
    // RGBA: 4 bytes per pixel
    this.frameSize = width * height * 4;
  }

  /**
   * Start consuming a stream URL and yield RGBA frames.
   * Spawns FFmpeg as a subprocess to decode video → raw RGBA.
   */
  async *extract(streamUrl: string): AsyncGenerator<Frame> {
    this.running = true;
    console.log(`[Bridge:whep] Starting FFmpeg extraction from ${streamUrl}`);

    this.ffmpeg = spawn('ffmpeg', [
      '-i', streamUrl,
      '-f', 'rawvideo',
      '-pix_fmt', 'rgba',
      '-s', `${this.width}x${this.height}`,
      '-r', String(this.fps),
      '-loglevel', 'error',
      'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    this.ffmpeg.stderr?.on('data', (data: Buffer) => {
      console.error(`[Bridge:ffmpeg] ${data.toString().trim()}`);
    });

    const frameQueue: Frame[] = [];
    let resolve: (() => void) | null = null;
    let done = false;

    this.ffmpeg.stdout?.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);

      while (this.buffer.length >= this.frameSize) {
        const frameData = new Uint8Array(this.buffer.subarray(0, this.frameSize));
        this.buffer = this.buffer.subarray(this.frameSize);
        frameQueue.push({ data: frameData, width: this.width, height: this.height });
        resolve?.();
      }
    });

    this.ffmpeg.on('close', () => {
      done = true;
      this.running = false;
      resolve?.();
    });

    // Yield frames as they arrive
    while (this.running || frameQueue.length > 0) {
      if (frameQueue.length > 0) {
        yield frameQueue.shift()!;
      } else if (!done) {
        await new Promise<void>((r) => { resolve = r; });
      } else {
        break;
      }
    }

    console.log('[Bridge:whep] Frame extraction ended');
  }

  stop(): void {
    this.running = false;
    if (this.ffmpeg) {
      this.ffmpeg.kill('SIGTERM');
      this.ffmpeg = null;
    }
  }
}
