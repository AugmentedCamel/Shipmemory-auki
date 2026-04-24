import type { AppSession, AudioOutputStream } from '@mentra/sdk';
import { AppState } from './state.js';
import { buildSystemPrompt } from './promptTemplate.js';
import { GeminiLiveClient, type GeminiFunctionCall } from '../gemini/liveClient.js';
import { WeriftWhepClient } from '../bridge/whepClient.js';
import { FrameRelay, jpegToFrame } from '../bridge/frameConverter.js';
import { subscribeMic } from '../mentra/mic.js';
import { showText } from '../mentra/display.js';
import { startLivestream, stopLivestream, type StreamStatusEvent } from '../mentra/camera.js';
import { ShipMemoryService } from '../shipmemory/service.js';
import { MockShipMemoryService, HardcodedUrlProvider } from '../shipmemory/mock.js';
import type { ContextCard, ContextProvider } from '../shipmemory/types.js';
import type { env as Env } from '../config/env.js';
import { streamState, transcriptEvents } from '../index.js';

const TOOL_TIMEOUT_MS = 10_000;
const SCAN_TIMEOUT_MS = 120_000;
const GEMINI_FRAME_INTERVAL_MS = 1000;

export class SessionOrchestrator {
  private state = AppState.IDLE;

  getState(): AppState {
    return this.state;
  }
  private gemini: GeminiLiveClient;
  private whepClient: WeriftWhepClient;
  private contextProvider: ContextProvider;
  private card: ContextCard | null = null;
  private frameRelay: FrameRelay | null = null;

  private scanCountdownTimer: ReturnType<typeof setInterval> | null = null;

  // Audio output: Gemini Live PCM16 → Mentra AudioOutputStream → glasses speaker.
  // Lazily created on first audio chunk; null between turns.
  private audioOutPromise: Promise<AudioOutputStream> | null = null;
  // Monotonic per-turn id. Late audio chunks tagged with a stale id are dropped
  // (mirrors stepper-ai's cancelledResponseIds set; Gemini Live has no per-
  // response_id, so we use turn boundaries instead).
  private currentTurnId = 0;

  constructor(
    private session: AppSession,
    private sessionId: string,
    private config: typeof Env,
  ) {
    this.gemini = new GeminiLiveClient(config.GEMINI_API_KEY, {
      onAudioReceived: (b64, arrivedAt) => this.handleAudioChunk(b64, arrivedAt),
      onOutputTranscription: (text) => this.handleOutputTranscription(text),
      onInputTranscription: (text) => {
        console.log(`[User] ${text}`);
        transcriptEvents.emit('event', { type: 'user', text });
      },
      onTurnComplete: () => this.handleTurnComplete(),
      onInterrupted: () => this.handleInterrupted(),
      onSpeechEnd: (speechEndAt, activityEndAt) => {
        this.turnSpeechEndAt = speechEndAt;
        this.turnActivityEndAt = activityEndAt;
        transcriptEvents.emit('event', { type: 'thinking' });
      },
      onToolCall: (calls) => this.handleToolCalls(calls),
      onToolCallCancellation: (ids) => console.log(`[Gemini] Tool calls cancelled: ${ids.join(', ')}`),
      onDisconnected: (reason) => this.handleDisconnect(reason),
      onError: (err) => console.error('[Gemini] Error:', err),
    });

    this.whepClient = new WeriftWhepClient(640, 480);

    // Pick context provider based on config:
    // 1. CONTEXT_CARD_URL set → fetch card directly from that URL (no QR needed)
    // 2. BRIDGE_BASE_URL set → real QR scanning via camera frames
    // 3. Otherwise → mock card for testing the voice loop
    if (config.CONTEXT_CARD_URL) {
      this.contextProvider = new HardcodedUrlProvider(config.CONTEXT_CARD_URL, config.BRIDGE_API_KEY);
    } else if (config.BRIDGE_BASE_URL) {
      this.contextProvider = new ShipMemoryService(config.BRIDGE_API_KEY);
    } else {
      this.contextProvider = new MockShipMemoryService();
    }
  }

  /** Stream URL for frame extraction (set after camera starts) */
  private streamUrl: string | null = null;
  private unsubscribeStreamStatus: (() => void) | null = null;
  private restartInFlight = false;

  async start(): Promise<void> {
    console.log(`[Session] Starting orchestrator (provider: ${this.contextProvider.constructor.name})`);

    this.transition(AppState.SCANNING);
    showText(this.session, 'Loading…');

    const needsCamera = this.contextProvider instanceof ShipMemoryService;

    if (needsCamera) {
      // Camera must start FIRST so QR scanner has frames to scan
      await this.startCameraForScanning();

      this.frameRelay = new FrameRelay();

      // Start unified WHEP loop in background — feeds relay during SCANNING,
      // sends JPEGs to Gemini during SESSION. Runs until state == IDLE.
      this.runWhepLoop().catch((err) => console.error('[Session] WHEP loop error:', err));

      await this.attemptScan();
      // On timeout, attemptScan returns without throwing; orchestrator stays
      // in SCANNING with scanStatus='timeout' waiting for /api/rescan.
      if (!this.card) return;
    } else {
      const emptyFrames = (async function* () {})();
      const card = await this.contextProvider.scan(emptyFrames);
      this.card = card;
    }

    console.log(`[Session] Got context card: ${this.card!.body.slice(0, 80)}…`);

    await this.startGeminiSession(this.card!);

    // For non-camera providers, start camera in background now so Gemini gets video.
    // For camera-first path, WHEP loop is already running and will pick up SESSION mode.
    if (!needsCamera) {
      this.startCamera();
    }
  }

  /**
   * One scan attempt with timeout + live countdown on glasses. On success,
   * sets this.card and starts Gemini. On timeout, flips scanStatus to
   * 'timeout' and shows a persistent error message — does NOT throw, so
   * the orchestrator stays in SCANNING waiting for /api/rescan.
   */
  private async attemptScan(): Promise<void> {
    if (!this.frameRelay) throw new Error('attemptScan called without frameRelay');
    streamState.scanStatus = 'active';
    streamState.scanStartedAt = Date.now();
    this.startScanCountdown();
    try {
      const card = await this.scanWithTimeout(this.frameRelay);
      this.stopScanCountdown();
      this.frameRelay.stop();
      streamState.scanStatus = 'idle';
      streamState.scanStartedAt = null;
      this.card = card;
      showText(this.session, 'QR found ✓', 2000);
    } catch (err) {
      this.stopScanCountdown();
      streamState.scanStatus = 'timeout';
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[Session] Scan timed out — awaiting manual rescan: ${msg}`);
      // Long duration so the message persists until user acts. SDK will
      // refresh if we call showText again (via rescan).
      showText(this.session, 'Scan timeout — tap Retry on phone', 600_000);
    }
  }

  /** Called by /api/rescan when user taps "Retry scanning" after a timeout. */
  async rescan(): Promise<void> {
    if (this.state !== AppState.SCANNING) {
      throw new Error(`rescan invalid in state ${this.state}`);
    }
    if (streamState.scanStatus !== 'timeout') {
      throw new Error(`rescan invalid when scanStatus=${streamState.scanStatus}`);
    }
    console.log('[Session] Rescan requested');
    // Old relay is dead (scan() threw and exited its consumer loop). Swap in
    // a fresh one — the WHEP loop reads this.frameRelay by reference on each
    // iteration, so new frames start flowing to the new relay immediately.
    this.frameRelay?.stop();
    this.frameRelay = new FrameRelay();
    await this.attemptScan();
    if (this.card) {
      await this.startGeminiSession(this.card);
    }
  }

  /**
   * User pressed "Stop session" during a live Gemini session. End Gemini,
   * close audio, swap the frame relay, and go back into scan mode so the
   * next QR can start a fresh session.
   */
  async stopSession(): Promise<void> {
    if (this.state !== AppState.SESSION) {
      throw new Error(`stopSession invalid in state ${this.state}`);
    }
    console.log('[Session] User stopped session — returning to scan mode');
    streamState.sessionEndReason = 'user_stop';
    // Transition first so handleDisconnect's state===SESSION guard no-ops
    // when gemini.disconnect() fires its onDisconnected callback below.
    this.transition(AppState.SCANNING);
    await this.restartScanPhase();
  }

  /**
   * Tear down the Gemini half of the session (disconnect, close audio,
   * clear card), reset the frame relay, and start a fresh scan. Used by
   * both stopSession() (user-initiated) and handleDisconnect() (Gemini
   * dropped). Caller is expected to have already transitioned to SCANNING.
   */
  private async restartScanPhase(): Promise<void> {
    safely('gemini.disconnect', () => this.gemini.disconnect());
    safely('audio.close', () => this.closeAudioStream());
    this.card = null;
    this.frameRelay?.stop();
    this.frameRelay = new FrameRelay();
    await this.attemptScan();
    if (this.card) {
      // Successful rescan → clear the prior end reason before the new
      // session takes over so the toolbar doesn't keep showing it.
      streamState.sessionEndReason = null;
      await this.startGeminiSession(this.card);
    }
  }

  private startScanCountdown(): void {
    this.stopScanCountdown();
    const startedAt = streamState.scanStartedAt ?? Date.now();
    const tick = () => {
      if (this.state !== AppState.SCANNING || streamState.scanStatus !== 'active') return;
      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      const mm = Math.floor(elapsed / 60);
      const ss = (elapsed % 60).toString().padStart(2, '0');
      showText(this.session, `Scanning QR… (${mm}:${ss})`, 5000);
    };
    tick();
    this.scanCountdownTimer = setInterval(tick, 2000);
  }

  private stopScanCountdown(): void {
    if (this.scanCountdownTimer) {
      clearInterval(this.scanCountdownTimer);
      this.scanCountdownTimer = null;
    }
  }

  /** Race provider.scan() against a timeout so we don't hang forever. */
  private async scanWithTimeout(relay: FrameRelay): Promise<ContextCard> {
    const scanPromise = this.contextProvider.scan(relay);
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`QR scan timed out after ${SCAN_TIMEOUT_MS / 1000}s`)), SCAN_TIMEOUT_MS),
    );
    return Promise.race([scanPromise, timeoutPromise]);
  }

  /** Start livestream synchronously — required before QR scanning can begin. */
  private async startCameraForScanning(): Promise<void> {
    streamState.status = 'starting';
    const urls = await startLivestream(this.session, (ev) => this.handleStreamStatus(ev));
    this.streamUrl = urls.webrtcUrl ?? null;
    this.unsubscribeStreamStatus = urls.unsubscribeStatus;
    streamState.hlsUrl = urls.hlsUrl;
    streamState.dashUrl = urls.dashUrl;
    streamState.webrtcUrl = urls.webrtcUrl ?? null;
    streamState.status = 'active';
    console.log(`[Session] Camera stream ready — WebRTC: ${this.streamUrl}`);

    if (!this.streamUrl) {
      throw new Error('No WebRTC URL — cannot scan for QR codes without camera');
    }
  }

  /** Start camera livestream in background — non-blocking, video is optional. */
  private async startCamera(): Promise<void> {
    try {
      streamState.status = 'starting';
      const urls = await startLivestream(this.session, (ev) => this.handleStreamStatus(ev));
      this.streamUrl = urls.webrtcUrl ?? null;
      this.unsubscribeStreamStatus = urls.unsubscribeStatus;
      streamState.hlsUrl = urls.hlsUrl;
      streamState.dashUrl = urls.dashUrl;
      streamState.webrtcUrl = urls.webrtcUrl ?? null;
      streamState.status = 'active';
      console.log(`[Session] Camera stream ready — WebRTC: ${this.streamUrl}`);

      if (this.streamUrl) {
        this.runWhepLoop().catch((err) => console.error('[Session] WHEP loop error:', err));
      } else {
        console.warn('[Session] No WebRTC URL — video frames unavailable');
      }
    } catch (err) {
      console.warn('[Session] Camera stream failed, continuing voice-only:', err);
      streamState.status = 'idle';
    }
  }

  /**
   * React to post-startup managed-stream status changes (Mentra cloud → us).
   * The one case we actively handle is `error`: Cloudflare / Mentra dropped the
   * stream mid-session (e.g. Mentra bug #2526). We try exactly one restart.
   */
  private handleStreamStatus(event: StreamStatusEvent): void {
    if (this.state === AppState.IDLE) return;
    if (event.type === 'error') {
      if (this.restartInFlight) {
        console.warn('[Session] Stream error while restart already in flight — ignoring');
        return;
      }
      console.warn(`[Session] Managed stream errored post-startup: ${event.message ?? 'no message'} — restarting`);
      this.restartStream().catch((err) => {
        console.error('[Session] restartStream failed:', err);
        streamState.status = 'error';
        showText(this.session, 'Stream lost — voice only', 5000);
      });
    }
  }

  /** Tear down the current WHEP/stream and ask Mentra for a fresh one. */
  async restartStream(): Promise<void> {
    if (this.restartInFlight) {
      console.warn('[Session] restartStream requested while already in flight — ignoring');
      return;
    }
    this.restartInFlight = true;
    streamState.status = 'reconnecting';
    showText(this.session, 'Restarting stream…', 5000);
    // Clear the stale cached frame so Gemini's speech-start/end handlers
    // don't re-send it while we reconnect.
    streamState.latestJpeg = null;
    streamState.latestJpegTime = 0;

    try {
      // Drop the dead listener and WHEP consumer from the previous stream.
      this.unsubscribeStreamStatus?.();
      this.unsubscribeStreamStatus = null;
      safely('whep.stop on restart', () => this.whepClient.stop());
      try {
        await stopLivestream(this.session);
      } catch (e) {
        console.warn(`[Session] stopLivestream during restart failed: ${e instanceof Error ? e.message : e}`);
      }

      const urls = await startLivestream(this.session, (ev) => this.handleStreamStatus(ev));
      this.unsubscribeStreamStatus = urls.unsubscribeStatus;
      this.streamUrl = urls.webrtcUrl ?? null;
      streamState.hlsUrl = urls.hlsUrl;
      streamState.dashUrl = urls.dashUrl;
      streamState.webrtcUrl = urls.webrtcUrl ?? null;
      streamState.status = 'active';
      console.log(`[Session] Camera stream restarted — WebRTC: ${this.streamUrl}`);

      if (this.streamUrl) {
        // Fresh WHEP client for the new URL. The old one was stopped above and
        // its PeerConnection + ffmpeg are gone.
        this.whepClient = new WeriftWhepClient(640, 480);
        this.runWhepLoop().catch((err) => console.error('[Session] WHEP loop error (post-restart):', err));
      }
    } finally {
      this.restartInFlight = false;
    }
  }

  private async startGeminiSession(card: ContextCard): Promise<void> {
    this.transition(AppState.SESSION);
    showText(this.session, 'Gemini connecting…');

    const systemPrompt = buildSystemPrompt(card);
    await this.gemini.connect(systemPrompt, card);

    console.log('[Session] Gemini Live session active');

    // Pre-warm the audio output stream BEFORE the user can talk so
    // ExoPlayer is fully buffered and ready to play the first reply
    // without a "missing opening words" gap. Awaited deliberately.
    await this.ensureAudioStream();

    showText(this.session, 'Ready');

    // Wire mic audio → Gemini
    subscribeMic(this.session, (pcm) => {
      this.gemini.sendAudio(pcm);
    });

    // Provide latest camera frame to Gemini — sent on-demand at speech start
    this.gemini.latestFrameProvider = () => ({
      jpeg: streamState.latestJpeg,
      capturedAt: streamState.latestJpegTime,
      frameNum: streamState.frameCount,
    });
  }

  /**
   * Unified WHEP consumption loop for the entire session lifetime.
   * - SCANNING: decode JPEG→RGBA, push to frameRelay for QR scanner
   * - SESSION:  send JPEGs to Gemini at 1fps
   * Runs until state == IDLE.
   */
  private async runWhepLoop(): Promise<void> {
    if (!this.streamUrl) return;
    console.log(`[Session] Starting WHEP loop on ${this.streamUrl}`);

    let frameCount = 0;
    let scanAttempts = 0;
    let lastGeminiSend = 0;

    try {
      for await (const { jpeg } of this.whepClient.connect(this.streamUrl)) {
        if (this.state === AppState.IDLE) break;

        frameCount++;
        streamState.latestJpeg = jpeg;
        streamState.latestJpegTime = Date.now();
        streamState.frameCount = frameCount;

        if (this.state === AppState.SCANNING && this.frameRelay) {
          try {
            const frame = jpegToFrame(jpeg);
            this.frameRelay.push(frame);
            scanAttempts++;
            if (scanAttempts % 30 === 0) {
              console.log(`[Session:scan] ${scanAttempts} frames scanned, no QR yet`);
            }
          } catch {
            // Partial/corrupted JPEG — skip silently
          }
        } else if (this.state === AppState.SESSION) {
          const now = Date.now();
          if ((now - lastGeminiSend) >= GEMINI_FRAME_INTERVAL_MS) {
            this.gemini.sendVideoFrame(jpeg, streamState.frameCount);
            lastGeminiSend = now;
          }
        }

        if (frameCount % 30 === 1) {
          console.log(`[Session:video] Frame #${frameCount} (${(jpeg.length / 1024).toFixed(1)}KB, state=${this.state})`);
        }
      }
    } catch (err) {
      console.error('[Session] WHEP loop error:', err);
    }
  }

  private handleOutputTranscription(text: string): void {
    // Audio plays directly via Gemini → createOutputStream. Transcript is
    // for the webview panel only; no TTS round-trip.
    transcriptEvents.emit('event', { type: 'ai', text });
  }

  /**
   * Idempotently opens the audio output stream so the phone's ExoPlayer
   * has the relay URL and is connected before the first chunk arrives.
   * Without this, every turn pays a ~1s warmup penalty (bytes written
   * before ExoPlayer subscribes are dropped by the relay).
   */
  private async ensureAudioStream(): Promise<void> {
    if (this.audioOutPromise) {
      try { await this.audioOutPromise; } catch {}
      return;
    }
    const t0 = Date.now();
    const promise = this.session.audio
      .createOutputStream({
        format: 'pcm16',
        sampleRate: 24000,
        channels: 1,
      })
      .then((s) => this.instrumentStream(s));
    this.audioOutPromise = promise;
    try {
      const s = await promise;
      console.log(
        `[Session:audio] stream ${s.streamId.slice(0, 8)} ready in ${Date.now() - t0}ms (state=${s.state})`,
      );
      this.primeExoPlayerBuffer(s);
    } catch (err) {
      console.error('[Session:audio] createOutputStream failed:', err);
      if (this.audioOutPromise === promise) this.audioOutPromise = null;
    }
  }

  /**
   * Push ~250ms of silence into the freshly-opened stream so ExoPlayer's
   * MP3 decoder is warmed and its prebuffer is filled. Without this, the
   * first real audio chunk has to wait for ExoPlayer to fill its initial
   * buffer (~500ms over HTTP-chunked) before pressing play, which is what
   * "missing the first second" actually was. 250ms silence at 24kHz mono
   * int16 = 6000 samples = 12000 zero bytes. Lamejs encodes those into a
   * couple of valid MP3 frames so the decoder sees real data, not EOF.
   */
  private primeExoPlayerBuffer(s: AudioOutputStream): void {
    const SILENCE_MS = 250;
    const bytes = (24000 * 2 * SILENCE_MS) / 1000; // sampleRate * 2B per sample
    const silence = Buffer.alloc(bytes);
    s.write(silence);
    console.log(`[Session:audio] stream ${s.streamId.slice(0, 8)} primed with ${SILENCE_MS}ms silence (${bytes}B PCM)`);
    // Arm the keepalive so silence keeps flowing during pre-first-turn idle.
    this.scheduleKeepAlive();
  }

  /**
   * Silence keepalive. MP3-over-HTTP-chunked needs continuous byte flow or
   * ExoPlayer underruns/idles its decoder; once that happens, subsequent
   * writes on the same stream are silently ignored on the phone side.
   *
   * Between Gemini turns there's a 4-8s gap where no real audio flows. We
   * fill it with short silence bursts (~100ms every 500ms) so the decoder
   * stays warm and the next real reply plays cleanly. This mirrors the
   * always-on AudioRecord pattern in the Android reference client and what
   * stepper-ai relies on.
   *
   * Re-armed after every real audio write — when Gemini is actively
   * streaming, the timer never fires.
   */
  private readonly KEEPALIVE_IDLE_MS = 500;
  private readonly KEEPALIVE_SILENCE_MS = 100;
  private silenceKeepAliveTimer: ReturnType<typeof setTimeout> | null = null;
  private keepAliveWrites = 0;
  private keepAliveLastLogged = 0;

  private scheduleKeepAlive(): void {
    if (this.silenceKeepAliveTimer) clearTimeout(this.silenceKeepAliveTimer);
    this.silenceKeepAliveTimer = setTimeout(() => {
      this.silenceKeepAliveTimer = null;
      void this.writeKeepAliveSilence();
    }, this.KEEPALIVE_IDLE_MS);
  }

  private async writeKeepAliveSilence(): Promise<void> {
    if (!this.audioOutPromise) return;
    let stream: AudioOutputStream;
    try { stream = await this.audioOutPromise; } catch { return; }
    if (stream.state !== 'streaming') return;
    const bytes = (24000 * 2 * this.KEEPALIVE_SILENCE_MS) / 1000;
    stream.write(Buffer.alloc(bytes));
    this.keepAliveWrites++;
    const now = Date.now();
    if (now - this.keepAliveLastLogged >= 2000) {
      console.log(
        `[Session:audio] keepalive silence x${this.keepAliveWrites} ` +
        `(${this.KEEPALIVE_SILENCE_MS}ms bursts every ${this.KEEPALIVE_IDLE_MS}ms during gaps)`,
      );
      this.keepAliveLastLogged = now;
    }
    this.scheduleKeepAlive();
  }

  private cancelKeepAlive(): void {
    if (this.silenceKeepAliveTimer) {
      clearTimeout(this.silenceKeepAliveTimer);
      this.silenceKeepAliveTimer = null;
    }
  }

  /**
   * One-shot per-turn latency breakdown so we can see where wall-clock
   * time is going between the user finishing their question and the
   * first real audio byte shipping out to the cloud relay.
   *
   * Anything past the "ship to cloud" point (cloud → phone → ExoPlayer
   * decode + playout) is invisible to us; if perceived latency is much
   * larger than TOTAL here, the missing time is on the phone side.
   */
  private logLatencyBreakdown(shipAt: number): void {
    const speechToActivity = this.turnActivityEndAt - this.turnSpeechEndAt;
    const activityToGemini = this.turnFirstGeminiAt - this.turnActivityEndAt;
    const geminiToShip = shipAt - this.turnFirstGeminiAt;
    const total = shipAt - this.turnSpeechEndAt;
    console.log(
      `[Session:latency] turn ${this.currentTurnId}: ` +
      `speech_end→activity_end=${speechToActivity}ms | ` +
      `activity_end→gemini_first=${activityToGemini}ms | ` +
      `gemini_first→ship=${geminiToShip}ms | ` +
      `TOTAL=${total}ms (speech_end → first real byte shipped to cloud)`,
    );
  }

  // Throttled write-rate logger so we can see when audio is actively
  // flowing to the glasses and correlate with mic chunk gaps.
  private writeWindowStart = 0;
  private writeWindowBytes = 0;
  private writeWindowCount = 0;
  private lastStreamState: string | null = null;

  // Per-turn audio metrics. Reset on each turn boundary (turnComplete /
  // interrupted) so we can correlate "missed first second" / "stopped after
  // a while" with what the SDK actually saw and emitted.
  private turnPcmBytes = 0;
  private turnMp3Bytes = 0;
  private turnWrites = 0;
  private turnDropsState = 0;   // chunks dropped because stream wasn't 'streaming'
  private turnDropsStale = 0;   // chunks dropped because turn changed mid-flight
  private turnFirstWriteAt = 0;
  private turnFirstMp3At = 0;

  // Per-turn end-to-end latency markers. Each is a Date.now() captured at
  // the named event; from these we derive the speech-end → first-byte-shipped
  // breakdown that tells us where wall-clock time is going.
  private turnSpeechEndAt = 0;       // last real mic chunk we received
  private turnActivityEndAt = 0;     // we sent activityEnd to Gemini
  private turnFirstGeminiAt = 0;     // first non-empty audio chunk arrived from Gemini
  private turnLatencyLogged = false; // emit the breakdown line only once per turn

  /**
   * Wrap a freshly opened AudioOutputStream so we can see what actually
   * leaves the SDK after lamejs encoding (the bytes ExoPlayer will see),
   * and so we get notified if the SDK closes/errors the stream behind our
   * back. Both `close` and `error` are already emitted by the SDK — we just
   * never subscribed.
   */
  private instrumentStream(s: AudioOutputStream): AudioOutputStream {
    const id = s.streamId.slice(0, 8);
    // sendBinaryFrame is the function the SDK calls with the post-lamejs
    // MP3 bytes. Wrapping it lets us count the real bytes-on-the-wire to
    // the cloud relay (and ExoPlayer). Lamejs returns 0 bytes during warm
    // up, so this is the only way to see whether the first write actually
    // produced an MP3 frame yet.
    const sAny = s as unknown as { sendBinaryFrame: (b: Uint8Array) => void };
    const original = sAny.sendBinaryFrame.bind(s);
    sAny.sendBinaryFrame = (audioData: Uint8Array) => {
      if (audioData.length > 0 && this.turnFirstMp3At === 0) {
        this.turnFirstMp3At = Date.now();
        const lag = this.turnFirstWriteAt ? this.turnFirstMp3At - this.turnFirstWriteAt : 0;
        console.log(`[Session:audio] stream ${id} first MP3 frame: ${audioData.length}B (warmup: ${lag}ms after first PCM write)`);
      }
      this.turnMp3Bytes += audioData.length;
      return original(audioData);
    };
    s.on('close', () => console.log(`[Session:audio] stream ${id} closed (state=${s.state})`));
    s.on('error', (err) => console.error(`[Session:audio] stream ${id} error:`, err));
    return s;
  }

  private resetTurnMetrics(): void {
    this.turnPcmBytes = 0;
    this.turnMp3Bytes = 0;
    this.turnWrites = 0;
    this.turnDropsState = 0;
    this.turnDropsStale = 0;
    this.turnFirstWriteAt = 0;
    this.turnFirstMp3At = 0;
    this.turnSpeechEndAt = 0;
    this.turnActivityEndAt = 0;
    this.turnFirstGeminiAt = 0;
    this.turnLatencyLogged = false;
  }

  private async handleAudioChunk(b64: string, arrivedAt: number): Promise<void> {
    const myTurn = this.currentTurnId;
    const bytes = Buffer.byteLength(b64, 'base64');
    // Capture Gemini's first real-byte arrival the moment the WS callback
    // fires — BEFORE we await the stream promise — so the latency reflects
    // network + Gemini, not our own scheduling.
    if (bytes > 0 && this.turnFirstGeminiAt === 0) {
      this.turnFirstGeminiAt = arrivedAt;
    }

    // Defensive: if the stream got nuked between turns, reopen lazily.
    if (!this.audioOutPromise) this.ensureAudioStream();
    const promise = this.audioOutPromise;
    if (!promise) return;
    let stream: AudioOutputStream;
    try {
      stream = await promise;
    } catch {
      return; // already logged in ensureAudioStream
    }
    // Drop chunks from a turn cancelled while we were awaiting open().
    if (myTurn !== this.currentTurnId) {
      this.turnDropsStale++;
      return;
    }

    // Log every state transition on the output stream.
    if (stream.state !== this.lastStreamState) {
      console.log(`[Session:audio] stream state: ${this.lastStreamState ?? '(init)'} → ${stream.state}`);
      this.lastStreamState = stream.state;
    }

    if (stream.state === 'streaming' || stream.state === 'created') {
      this.turnPcmBytes += bytes;
      this.turnWrites++;
      if (this.turnFirstWriteAt === 0) this.turnFirstWriteAt = Date.now();
      stream.write(Buffer.from(b64, 'base64'));
      // Push the keepalive out — we just delivered real audio, no need for
      // silence fill until the next gap.
      this.scheduleKeepAlive();
      // Emit one latency-breakdown line per turn the moment real audio
      // bytes are first shipped to the SDK. Only fires when we actually
      // know when the user stopped speaking (i.e. an activityEnd was sent
      // for this turn — barge-in turns don't have one).
      if (bytes > 0 && !this.turnLatencyLogged && this.turnSpeechEndAt > 0) {
        this.turnLatencyLogged = true;
        this.logLatencyBreakdown(Date.now());
      }

      // Throttled write-rate log (once per ~1s of active writing).
      const now = Date.now();
      if (!this.writeWindowStart) this.writeWindowStart = now;
      this.writeWindowBytes += bytes;
      this.writeWindowCount++;
      if (now - this.writeWindowStart >= 1000) {
        console.log(
          `[Session:audio] writing — ${this.writeWindowCount} chunks, ${(this.writeWindowBytes / 1024).toFixed(1)}KB in ${now - this.writeWindowStart}ms (stream=${stream.state})`,
        );
        this.writeWindowStart = now;
        this.writeWindowBytes = 0;
        this.writeWindowCount = 0;
      }
    } else {
      this.turnDropsState++;
    }
  }

  /**
   * Turn ended cleanly. Keep the audio stream OPEN across turns — closing
   * and reopening per turn loses the first ~1s of the next reply to phone-
   * side ExoPlayer warmup, and after enough cycles wedges the phone's audio
   * pipeline. lamejs buffers at most ~48ms internally; the next turn's
   * first write pushes it through.
   */
  private handleTurnComplete(): void {
    if (this.turnWrites > 0) {
      const dur = this.turnFirstWriteAt ? Date.now() - this.turnFirstWriteAt : 0;
      console.log(
        `[Session:audio] turn ${this.currentTurnId} done — pcm_in=${(this.turnPcmBytes / 1024).toFixed(1)}KB ` +
        `mp3_out=${(this.turnMp3Bytes / 1024).toFixed(1)}KB writes=${this.turnWrites} ` +
        `drops(state/stale)=${this.turnDropsState}/${this.turnDropsStale} dur=${dur}ms`,
      );
    } else if (this.turnDropsState + this.turnDropsStale > 0) {
      console.warn(
        `[Session:audio] turn ${this.currentTurnId} done — ALL chunks dropped ` +
        `(state=${this.turnDropsState} stale=${this.turnDropsStale})`,
      );
    }
    this.resetTurnMetrics();
    transcriptEvents.emit('event', { type: 'turn_complete' });
    this.currentTurnId++;
  }

  /**
   * Interrupt fires on user barge-in AND when Gemini decides to call a tool
   * (it clears its pending model audio so the post-tool reply can take over).
   *
   * flush() terminates the stream, so we have to open a new one. The flush
   * and the create MUST be sequential — the SDK's activeOutputStream guard
   * rejects createOutputStream with AUDIO_STREAM_ALREADY_ACTIVE while the
   * old stream is still 'streaming'. We chain them in a single promise so
   * concurrent handleAudioChunk callers await the same chain and write into
   * the new stream once it's open. Stale chunks (myTurn !== currentTurnId)
   * still get dropped before the write.
   */
  /**
   * Gemini sent an interrupt. Previously we flushed + re-opened the audio
   * stream, but that triggered an SDK race ("audio play response for
   * unknown request ID") that wedged ExoPlayer after a few cycles.
   *
   * Now we keep the stream open for the entire session. The currentTurnId
   * bump still causes any in-flight Gemini chunks tagged with the old turn
   * to be dropped in handleAudioChunk before they reach the encoder. The
   * trade-off: whatever's already buffered on the phone-side ExoPlayer
   * plays out to completion — we cannot stop it mid-buffer without
   * tearing down the stream. That's acceptable; SDK stability wins.
   */
  private handleInterrupted(): void {
    console.log(
      `[Session:audio] interrupt — turn=${this.currentTurnId} ` +
      `pcm_in=${(this.turnPcmBytes / 1024).toFixed(1)}KB mp3_out=${(this.turnMp3Bytes / 1024).toFixed(1)}KB ` +
      `writes=${this.turnWrites} drops=${this.turnDropsState + this.turnDropsStale} (stream stays open)`,
    );
    this.currentTurnId++;
    this.resetTurnMetrics();
  }

  /** Final cleanup at session end — flush without re-warming. */
  private closeAudioStream(): void {
    this.cancelKeepAlive();
    const promise = this.audioOutPromise;
    this.audioOutPromise = null;
    promise?.then((s) => s.flush()).catch(() => {});
  }

  private async handleToolCalls(calls: GeminiFunctionCall[]): Promise<void> {
    if (!this.card?.execute_url) {
      console.warn('[Session] Tool call received but no execute_url configured');
      for (const call of calls) {
        this.gemini.sendToolResponse(call.id, call.name, {
          status: 'error',
          message: 'No execute_url configured for this context card',
        });
      }
      return;
    }

    for (const call of calls) {
      console.log(`[Tool] Executing: ${call.name}(${JSON.stringify(call.args)})`);
      try {
        const result = await this.executeTool(call);
        this.gemini.sendToolResponse(call.id, call.name, result);
      } catch (err) {
        console.error(`[Tool] ${call.name} failed:`, err);
        this.gemini.sendToolResponse(call.id, call.name, {
          status: 'error',
          message: err instanceof Error ? err.message : 'Tool execution failed',
        });
      }
    }
  }

  private async executeTool(call: GeminiFunctionCall): Promise<Record<string, unknown>> {
    // Matches PROTOCOL.md §3: { tool, params }. session_id is injected from
    // the Mentra sessionId so tools (like session_history) can scope storage
    // per conversation without having to teach Gemini our session IDs.
    const url = new URL(this.card!.execute_url!);
    if (this.config.BRIDGE_API_KEY) url.searchParams.set('key', this.config.BRIDGE_API_KEY);

    const body = {
      tool: call.name,
      params: { ...(call.args ?? {}), session_id: this.sessionId },
    };
    // Log the destination without the key — so we can verify the URL and
    // see whether the key got appended at all (has_key=true/false).
    const logUrl = url.origin + url.pathname;
    const hasKey = url.searchParams.has('key');
    console.log(`[Tool] POST ${logUrl} has_key=${hasKey} body=${JSON.stringify(body)}`);

    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TOOL_TIMEOUT_MS),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`[Tool] ${call.name} -> ${res.status}: ${errText}`);
      throw new Error(`Tool API returned ${res.status}: ${errText}`);
    }

    const json = await res.json() as Record<string, unknown>;
    console.log(`[Tool] ${call.name} -> 200: ${JSON.stringify(json)}`);
    return json;
  }

  private handleDisconnect(reason?: string): void {
    console.log(`[Session] Disconnected: ${reason ?? 'unknown'}`);
    if (this.state === AppState.SESSION) {
      const r = reason ?? 'gemini_disconnect';
      streamState.sessionEndReason = r;
      // Auto-return to scan mode. User doesn't have to do anything — next
      // QR starts a fresh session. If they wanted to stop the whole thing
      // they'd close the app on the glasses.
      console.log(`[Session] Gemini disconnected (${r}) — auto-restarting scan`);
      this.transition(AppState.SCANNING);
      queueMicrotask(() => {
        this.restartScanPhase().catch((err) =>
          console.error('[Session] auto-restartScanPhase failed:', err),
        );
      });
    }
  }

  private transition(newState: AppState): void {
    console.log(`[Session] ${this.state} → ${newState}`);
    this.state = newState;
  }

  destroy(reason: string): void {
    console.log(`[Session] Destroying orchestrator (trigger: ${reason}) — cleaning up`);
    this.transition(AppState.IDLE);

    safely('scanCountdown.stop',  () => this.stopScanCountdown());
    safely('gemini.disconnect',   () => this.gemini.disconnect());
    safely('whep.stop',           () => this.whepClient.stop());
    safely('relay.stop',          () => this.frameRelay?.stop());
    safely('audio.close',         () => this.closeAudioStream());
    safely('unsubscribeStream',   () => this.unsubscribeStreamStatus?.());
    stopLivestream(this.session).catch((e) =>
      console.warn(`[Session] stopLivestream failed: ${e instanceof Error ? e.message : e}`),
    );
  }
}

function safely(name: string, fn: () => void): void {
  try {
    fn();
  } catch (e) {
    console.warn(`[Session] cleanup ${name} threw: ${e instanceof Error ? e.message : e}`);
  }
}
