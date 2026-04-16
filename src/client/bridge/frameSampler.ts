import type { Frame } from '../shipmemory/types.js';
import { avgLuminance, perceptualHash, hammingDistance } from './frameUtils.js';

export type SamplerMode = 'scanning' | 'session';

interface SkipResult {
  accept: false;
  reason: string;
}

interface AcceptResult {
  accept: true;
}

type FilterResult = SkipResult | AcceptResult;

/**
 * Dual-mode frame sampler with luminance and motion filtering.
 * - SCANNING: ~3fps, for QR code detection
 * - SESSION: ~1fps, for Gemini video input
 */
export class FrameSampler {
  private lastHash = 0;
  private lastAcceptTime = 0;
  private stats = {
    accepted: 0,
    skippedDark: 0,
    skippedBright: 0,
    skippedStatic: 0,
    skippedBlur: 0,
    throttled: 0,
    total: 0,
  };
  private statsInterval: ReturnType<typeof setInterval>;

  constructor(
    private mode: SamplerMode,
    private log: (tag: string, data: Record<string, unknown>) => void = (tag, data) =>
      console.log(`[${tag}]`, JSON.stringify(data)),
  ) {
    this.statsInterval = setInterval(() => this.logStats(), 5000);
  }

  get targetFps(): number {
    return this.mode === 'scanning' ? 3 : 1;
  }

  shouldProcess(frame: Frame): FilterResult {
    this.stats.total++;
    const now = Date.now();
    const minInterval = 1000 / this.targetFps;

    // Throttle
    if (now - this.lastAcceptTime < minInterval) {
      this.stats.throttled++;
      return { accept: false, reason: 'throttle' };
    }

    // Luminance check
    const lum = avgLuminance(frame);
    if (lum < 30) {
      this.stats.skippedDark++;
      this.log('Frame:skip', { reason: 'dark', lum: Math.round(lum) });
      return { accept: false, reason: 'dark' };
    }
    if (lum > 225) {
      this.stats.skippedBright++;
      this.log('Frame:skip', { reason: 'bright', lum: Math.round(lum) });
      return { accept: false, reason: 'bright' };
    }

    // Motion check via perceptual hash
    const hash = perceptualHash(frame);
    const diff = hammingDistance(hash, this.lastHash);
    if (this.lastHash !== 0) {
      if (diff < 3) {
        this.stats.skippedStatic++;
        this.log('Frame:skip', { reason: 'static', diff });
        return { accept: false, reason: 'static' };
      }
      if (diff > 40) {
        this.stats.skippedBlur++;
        this.log('Frame:skip', { reason: 'blur', diff });
        return { accept: false, reason: 'blur' };
      }
    }

    this.lastHash = hash;
    this.lastAcceptTime = now;
    this.stats.accepted++;
    this.log('Frame:accept', { lum: Math.round(lum), diff, mode: this.mode });
    return { accept: true };
  }

  switchMode(mode: SamplerMode): void {
    this.log('Frame:mode', { from: this.mode, to: mode, targetFps: mode === 'scanning' ? 3 : 1 });
    this.mode = mode;
    // Reset hash so first frame in new mode is always accepted
    this.lastHash = 0;
  }

  private logStats(): void {
    if (this.stats.total === 0) return;
    this.log('Frame:stats', {
      mode: this.mode,
      total: this.stats.total,
      accepted: this.stats.accepted,
      throttled: this.stats.throttled,
      skip_dark: this.stats.skippedDark,
      skip_bright: this.stats.skippedBright,
      skip_static: this.stats.skippedStatic,
      skip_blur: this.stats.skippedBlur,
    });
  }

  destroy(): void {
    clearInterval(this.statsInterval);
  }
}
