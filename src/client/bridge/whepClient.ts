import { spawn, type ChildProcess } from 'child_process';
import { RTCPeerConnection } from 'werift';
import type { Frame } from '../shipmemory/types.js';

/**
 * Server-side WHEP consumer using werift (pure TS WebRTC).
 *
 * Flow: WHEP POST (SDP offer) → Cloudflare → SDP answer
 *   → werift WebRTC connection → video RTP packets
 *   → reassemble VP8 frames → pipe to FFmpeg (VP8 → JPEG)
 *   → JPEG frames out
 *
 * Cloudflare Stream uses VP8 codec (not H264).
 */
export class WeriftWhepClient {
  private pc: RTCPeerConnection | null = null;
  private ffmpeg: ChildProcess | null = null;
  private running = false;
  private frameCount = 0;
  private rtpCount = 0;
  private lastLogTime = 0;
  private bytesToFfmpeg = 0;
  private bytesFromFfmpeg = 0;

  /** Latest extracted JPEG frame — served by /api/frame for debugging */
  latestJpeg: Buffer | null = null;

  // VP8 frame reassembly buffer
  private vp8Chunks: Buffer[] = [];
  private vp8FramesSent = 0;
  private gotKeyframe = false;
  private lastIvfTimestamp = -1; // Track last written IVF timestamp to guarantee monotonicity

  constructor(
    private width = 640,
    private height = 480,
    private fps = 3,
  ) {}

  /**
   * Connect to a WHEP endpoint and yield JPEG frames.
   * Each frame is also available as `latestJpeg` for the preview endpoint.
   */
  async *connect(whepUrl: string): AsyncGenerator<{ jpeg: Buffer; frame: Frame }> {
    this.running = true;
    console.log(`[WHEP] Connecting to ${whepUrl}`);

    // --- Step 1: werift WebRTC setup ---
    this.pc = new RTCPeerConnection({});

    // Cloudflare requires transceivers matching all tracks in the stream
    this.pc.addTransceiver('video', { direction: 'recvonly' });
    this.pc.addTransceiver('audio', { direction: 'recvonly' });

    // Connection state logging
    this.pc.connectionStateChange.subscribe((state) => {
      console.log(`[WHEP] Connection state: ${state}`);
    });
    this.pc.iceConnectionStateChange.subscribe((state) => {
      console.log(`[WHEP] ICE state: ${state}`);
    });

    // Create offer
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    console.log(`[WHEP] Created SDP offer (${offer.sdp!.length} bytes)`);

    // Log the codec lines from the SDP for debugging
    const codecLines = offer.sdp!.split('\n').filter(l => l.startsWith('a=rtpmap:'));
    console.log(`[WHEP] SDP offer codecs: ${codecLines.map(l => l.trim()).join(', ')}`);

    // --- Step 2: WHEP handshake ---
    const res = await fetch(whepUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp' },
      body: offer.sdp,
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`WHEP handshake failed: ${res.status} ${body.slice(0, 200)}`);
    }

    const answerSdp = await res.text();
    console.log(`[WHEP] Got SDP answer (${answerSdp.length} bytes)`);

    // Log the codec lines from the answer
    const answerCodecLines = answerSdp.split('\n').filter(l => l.startsWith('a=rtpmap:'));
    console.log(`[WHEP] SDP answer codecs: ${answerCodecLines.map(l => l.trim()).join(', ')}`);

    await this.pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
    console.log('[WHEP] Remote description set — waiting for video track');

    // --- Step 3: Start FFmpeg for IVF (VP8) → JPEG conversion ---
    // No -r flag: let FFmpeg output frames immediately (no internal buffering).
    // Rate limiting is done on the consumer side to avoid latency.
    this.ffmpeg = spawn('ffmpeg', [
      '-f', 'ivf',
      '-i', 'pipe:0',
      '-f', 'image2pipe',
      '-vcodec', 'mjpeg',
      '-pix_fmt', 'yuvj420p',
      '-q:v', '5',
      '-s', `${this.width}x${this.height}`,
      '-vsync', 'passthrough',  // Output every frame immediately, no buffering
      '-loglevel', 'warning',
      'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    this.ffmpeg.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) console.warn(`[WHEP:ffmpeg] ${msg}`);
    });

    this.ffmpeg.on('error', (err) => {
      console.error('[WHEP:ffmpeg] Process error:', err);
    });

    this.ffmpeg.on('close', (code) => {
      console.log(`[WHEP:ffmpeg] Process exited with code ${code}. Bytes in: ${this.bytesToFfmpeg}, bytes out: ${this.bytesFromFfmpeg}`);
    });

    // Write IVF file header (32 bytes) — FFmpeg needs this to parse the stream
    this.writeIvfHeader();

    // --- Step 4: Wire video RTP packets → reassemble VP8 frames → IVF → FFmpeg ---
    const handleVideoRtp = (rtp: any) => {
      if (!this.running || !this.ffmpeg?.stdin?.writable) return;

      this.rtpCount++;

      // Detailed logging for first 5 packets
      if (this.rtpCount <= 5) {
        const payload = rtp.payload as Buffer;
        const hex = payload.subarray(0, Math.min(20, payload.length)).toString('hex');
        const marker = rtp.header?.marker ?? '?';
        const seq = rtp.header?.sequenceNumber ?? '?';
        const ts = rtp.header?.timestamp ?? '?';
        console.log(`[WHEP:rtp] Packet #${this.rtpCount}: len=${payload.length} marker=${marker} seq=${seq} ts=${ts} hex=${hex}`);
      }

      // Periodic summary
      const now = Date.now();
      if (now - this.lastLogTime >= 5000) {
        console.log(`[WHEP:diag] RTP packets: ${this.rtpCount}, VP8 frames assembled: ${this.vp8FramesSent}, bytes→ffmpeg: ${this.bytesToFfmpeg}, bytes←ffmpeg: ${this.bytesFromFfmpeg}, JPEG out: ${this.frameCount}`);
        this.lastLogTime = now;
      }

      // VP8 RTP depacketization (RFC 7741)
      const payload = rtp.payload as Buffer;
      if (payload.length < 1) {
        if (this.rtpCount <= 20) console.log(`[WHEP:rtp] Empty payload, skipping`);
        return;
      }

      // VP8 RTP payload descriptor (RFC 7741 §4.2)
      //  0 1 2 3 4 5 6 7
      // +-+-+-+-+-+-+-+-+
      // |X|R|N|S|R| PID |
      // +-+-+-+-+-+-+-+-+
      const firstByte = payload[0];
      const X = (firstByte >> 7) & 1; // Extension bit
      const S = (firstByte >> 4) & 1; // Start of VP8 partition
      let headerLen = 1;

      if (X) {
        if (headerLen >= payload.length) return;
        const extByte = payload[headerLen];
        headerLen++;
        const I = (extByte >> 7) & 1; // PictureID present
        const L = (extByte >> 6) & 1; // TL0PICIDX present
        const T = (extByte >> 5) & 1; // TID present
        const K = (extByte >> 4) & 1; // KEYIDX present

        if (I) {
          if (headerLen >= payload.length) return;
          if (payload[headerLen] & 0x80) {
            headerLen += 2; // 16-bit PictureID (M bit set)
          } else {
            headerLen += 1; // 8-bit PictureID
          }
        }
        if (L) headerLen += 1;
        if (T || K) headerLen += 1;
      }

      if (headerLen > payload.length) {
        if (this.rtpCount <= 20) console.log(`[WHEP:rtp] Header overrun: headerLen=${headerLen} > payload=${payload.length}`);
        return;
      }

      const vp8Data = payload.subarray(headerLen);
      if (vp8Data.length === 0) {
        if (this.rtpCount <= 20) console.log(`[WHEP:rtp] No VP8 data after header strip (headerLen=${headerLen})`);
        return;
      }

      // Log depacketization for first 5 packets
      if (this.rtpCount <= 5) {
        const isKeyframe = S && vp8Data.length > 0 && (vp8Data[0] & 0x01) === 0;
        console.log(`[WHEP:vp8] Packet #${this.rtpCount}: X=${X} S=${S} headerLen=${headerLen} vp8DataLen=${vp8Data.length} keyframe=${isKeyframe}`);
      }

      if (S) {
        // Start of new VP8 frame — flush previous if any
        if (this.vp8Chunks.length > 0) {
          this.flushVp8Frame();
        }
      }

      this.vp8Chunks.push(Buffer.from(vp8Data));

      // RTP marker bit = end of frame
      const marker = rtp.header?.marker ?? false;
      if (marker && this.vp8Chunks.length > 0) {
        this.flushVp8Frame();
      }
    };

    // Subscribe to video track RTP immediately on the transceiver receiver.
    // onTrack never fires for recvonly transceivers we created, so we go direct.
    const videoTransceiver = this.pc.getTransceivers().find(t => t.kind === 'video');
    let pliSent = false;

    const sendPLI = () => {
      if (!videoTransceiver?.receiver) return;
      const ssrc = videoTransceiver.receiver.track?.ssrc;
      if (ssrc) {
        console.log(`[WHEP] Sending PLI for keyframe (SSRC: ${ssrc})`);
        videoTransceiver.receiver.sendRtcpPLI(ssrc).catch(e =>
          console.warn('[WHEP] PLI send failed:', e)
        );
      }
    };

    // Wrap the RTP handler to send PLI on first packet
    const handleVideoRtpWithPLI = (rtp: any) => {
      if (!pliSent) {
        pliSent = true;
        console.log('[WHEP] First RTP packet received — requesting keyframe via PLI');
        sendPLI();
        // Retry PLI in case first is lost
        setTimeout(sendPLI, 1000);
        setTimeout(sendPLI, 3000);
      }
      handleVideoRtp(rtp);
    };

    if (videoTransceiver?.receiver?.track) {
      console.log('[WHEP] Subscribing to video track RTP on transceiver receiver');
      videoTransceiver.receiver.track.onReceiveRtp.subscribe(handleVideoRtpWithPLI);
    } else {
      console.warn('[WHEP] No video track on transceiver yet — using onTrack fallback');
      this.pc.onTrack.subscribe((track: any) => {
        if (track.kind === 'video') {
          console.log('[WHEP] onTrack: subscribing to video RTP');
          track.onReceiveRtp.subscribe(handleVideoRtpWithPLI);
        }
      });
    }

    // Log if no RTP packets after 5s
    setTimeout(() => {
      if (this.rtpCount === 0) {
        console.warn('[WHEP:diag] No RTP packets received after 5s — stream may not be producing video');
      }
    }, 5000);

    // --- Step 5: Parse JPEG frames from FFmpeg stdout ---
    const jpegQueue: Buffer[] = [];
    let resolve: (() => void) | null = null;
    let done = false;
    let buffer = Buffer.alloc(0);

    this.ffmpeg.stdout?.on('data', (chunk: Buffer) => {
      this.bytesFromFfmpeg += chunk.length;
      buffer = Buffer.concat([buffer, chunk]);

      // Split on JPEG SOI markers (FF D8)
      while (true) {
        const soiStart = buffer.indexOf(Buffer.from([0xff, 0xd8]), 2);
        if (soiStart === -1) break;

        const jpeg = Buffer.from(buffer.subarray(0, soiStart));
        buffer = buffer.subarray(soiStart);

        if (jpeg.length > 100) {
          jpegQueue.push(jpeg);
          resolve?.();
        }
      }
    });

    this.ffmpeg.on('close', () => {
      if (buffer.length > 100) {
        jpegQueue.push(Buffer.from(buffer));
      }
      done = true;
      this.running = false;
      resolve?.();
    });

    // --- Step 6: Yield JPEG frames (always skip to latest to minimize latency) ---
    while (this.running || jpegQueue.length > 0) {
      if (jpegQueue.length > 0) {
        // Skip stale frames — only yield the most recent one
        const skipped = jpegQueue.length - 1;
        const jpeg = jpegQueue[jpegQueue.length - 1];
        jpegQueue.length = 0;
        this.frameCount++;
        this.latestJpeg = jpeg;

        if (skipped > 0) {
          console.log(`[WHEP] Skipped ${skipped} stale frames, yielding #${this.frameCount} (${(jpeg.length / 1024).toFixed(1)}KB)`);
        } else if (this.frameCount % 10 === 1) {
          console.log(`[WHEP] JPEG Frame #${this.frameCount} (${(jpeg.length / 1024).toFixed(1)}KB)`);
        }

        yield { jpeg, frame: { data: new Uint8Array(0), width: this.width, height: this.height, jpeg } };
      } else if (!done) {
        await new Promise<void>((r) => { resolve = r; });
      } else {
        break;
      }
    }

    console.log(`[WHEP] Stream ended — ${this.frameCount} total frames, ${this.vp8FramesSent} VP8 frames assembled`);
  }

  /** Write a 32-byte IVF file header for VP8. */
  private writeIvfHeader(): void {
    if (!this.ffmpeg?.stdin?.writable) return;
    const header = Buffer.alloc(32);
    header.write('DKIF', 0);              // Signature
    header.writeUInt16LE(0, 4);           // Version
    header.writeUInt16LE(32, 6);          // Header length
    header.write('VP80', 8);              // FourCC
    header.writeUInt16LE(this.width, 12); // Width
    header.writeUInt16LE(this.height, 14);// Height
    header.writeUInt32LE(1000, 16);       // Timebase denominator (milliseconds)
    header.writeUInt32LE(1, 20);          // Timebase numerator
    header.writeUInt32LE(0, 24);          // Frame count (unknown, 0)
    header.writeUInt32LE(0, 28);          // Unused
    this.ffmpeg.stdin.write(header);
    this.bytesToFfmpeg += 32;
    console.log('[WHEP] IVF header written (32 bytes)');
  }

  /** Reassemble and write one VP8 frame as an IVF frame to FFmpeg. */
  private flushVp8Frame(): void {
    if (this.vp8Chunks.length === 0) return;
    if (!this.ffmpeg?.stdin?.writable) return;

    const frame = Buffer.concat(this.vp8Chunks);
    this.vp8Chunks = [];

    // Log first 3 VP8 frames in detail
    if (this.vp8FramesSent < 3) {
      const isKeyframe = frame.length > 0 && (frame[0] & 0x01) === 0;
      const hex = frame.subarray(0, Math.min(16, frame.length)).toString('hex');
      console.log(`[WHEP:vp8] Flushing frame #${this.vp8FramesSent}: size=${frame.length} keyframe=${isKeyframe} hex=${hex}`);
    }

    // VP8 keyframe detection: first byte bit 0 == 0 means keyframe
    const isKeyframe = frame.length > 0 && (frame[0] & 0x01) === 0;

    // Don't send interframes to FFmpeg until we have a keyframe
    if (!this.gotKeyframe) {
      if (!isKeyframe) {
        if (this.vp8FramesSent === 0 || this.vp8FramesSent % 30 === 0) {
          console.log(`[WHEP:vp8] Waiting for keyframe (discarded ${this.vp8FramesSent} interframes so far)`);
        }
        this.vp8FramesSent++;
        return;
      }
      this.gotKeyframe = true;
      console.log(`[WHEP:vp8] ★ Got keyframe! size=${frame.length} — starting decode pipeline`);
    }

    // IVF frame header: 12 bytes (4 byte size LE + 8 byte timestamp LE)
    // Use wall-clock ms, guaranteed strictly monotonic (no RTP timestamp issues)
    const nowMs = Date.now();
    const ts = Math.max(nowMs, this.lastIvfTimestamp + 1); // always > last
    this.lastIvfTimestamp = ts;
    const frameHeader = Buffer.alloc(12);
    frameHeader.writeUInt32LE(frame.length, 0);
    frameHeader.writeBigUInt64LE(BigInt(ts), 4);

    this.ffmpeg.stdin.write(frameHeader);
    this.ffmpeg.stdin.write(frame);
    this.bytesToFfmpeg += 12 + frame.length;
    this.vp8FramesSent++;
  }

  stop(): void {
    console.log(`[WHEP] Stopping (RTP: ${this.rtpCount}, VP8 assembled: ${this.vp8FramesSent}, JPEG out: ${this.frameCount}, bytes→ffmpeg: ${this.bytesToFfmpeg}, bytes←ffmpeg: ${this.bytesFromFfmpeg})`);
    this.running = false;

    if (this.ffmpeg) {
      try { this.ffmpeg.stdin?.end(); } catch {}
      this.ffmpeg.kill('SIGTERM');
      this.ffmpeg = null;
    }

    if (this.pc) {
      this.pc.close().catch(() => {});
      this.pc = null;
    }
  }
}
