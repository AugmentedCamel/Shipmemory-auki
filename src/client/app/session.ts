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
      onAudioReceived: (b64) => this.handleAudioChunk(b64),
      onOutputTranscription: (text) => this.handleOutputTranscription(text),
      onInputTranscription: (text) => {
        console.log(`[User] ${text}`);
        transcriptEvents.emit('event', { type: 'user', text });
      },
      onTurnComplete: () => this.handleTurnComplete(),
      onInterrupted: () => this.handleInterrupted(),
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
    showText(this.session, 'Loading context…');

    const needsCamera = this.contextProvider instanceof ShipMemoryService;
    let card: ContextCard;

    if (needsCamera) {
      // Camera must start FIRST so QR scanner has frames to scan
      await this.startCameraForScanning();

      this.frameRelay = new FrameRelay();

      // Start unified WHEP loop in background — feeds relay during SCANNING,
      // sends JPEGs to Gemini during SESSION. Runs until state == IDLE.
      this.runWhepLoop().catch((err) => console.error('[Session] WHEP loop error:', err));

      showText(this.session, 'Point at a QR code…');
      card = await this.scanWithTimeout(this.frameRelay);
      this.frameRelay.stop();
    } else {
      const emptyFrames = (async function* () {})();
      card = await this.contextProvider.scan(emptyFrames);
    }

    this.card = card;
    console.log(`[Session] Got context card: ${card.body.slice(0, 80)}…`);

    await this.startGeminiSession(card);

    // For non-camera providers, start camera in background now so Gemini gets video.
    // For camera-first path, WHEP loop is already running and will pick up SESSION mode.
    if (!needsCamera) {
      this.startCamera();
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
      });
    }
  }

  /** Tear down the current WHEP/stream and ask Mentra for a fresh one. */
  private async restartStream(): Promise<void> {
    this.restartInFlight = true;
    streamState.status = 'reconnecting';
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
    showText(this.session, 'Connecting to Gemini…');

    const systemPrompt = buildSystemPrompt(card);
    await this.gemini.connect(systemPrompt, card);

    showText(this.session, 'Ready — speak to begin');
    console.log('[Session] Gemini Live session active');

    // Pre-warm the audio output stream so the first reply doesn't lose its
    // opening words to ExoPlayer warmup.
    this.ensureAudioStream();

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
  private ensureAudioStream(): void {
    if (this.audioOutPromise) return;
    const promise = this.session.audio.createOutputStream({
      format: 'pcm16',
      sampleRate: 24000,
      channels: 1,
    });
    this.audioOutPromise = promise;
    promise
      .then((s) => console.log(`[Session:audio] Output stream open (${s.streamId.slice(0, 8)})`))
      .catch((err) => {
        console.error('[Session:audio] createOutputStream failed:', err);
        if (this.audioOutPromise === promise) this.audioOutPromise = null;
      });
  }

  // Throttled write-rate logger so we can see when audio is actively
  // flowing to the glasses and correlate with mic chunk gaps.
  private writeWindowStart = 0;
  private writeWindowBytes = 0;
  private writeWindowCount = 0;
  private lastStreamState: string | null = null;

  private async handleAudioChunk(b64: string): Promise<void> {
    const myTurn = this.currentTurnId;
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
    if (myTurn !== this.currentTurnId) return;

    // Log every state transition on the output stream.
    if (stream.state !== this.lastStreamState) {
      console.log(`[Session:audio] stream state: ${this.lastStreamState ?? '(init)'} → ${stream.state}`);
      this.lastStreamState = stream.state;
    }

    if (stream.state === 'streaming' || stream.state === 'created') {
      const bytes = Buffer.byteLength(b64, 'base64');
      stream.write(Buffer.from(b64, 'base64'));

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
  private handleInterrupted(): void {
    console.log('[Session:audio] Interrupted — flushing audio output');
    this.currentTurnId++;
    const oldPromise = this.audioOutPromise;

    const next = (async () => {
      if (oldPromise) {
        try {
          const s = await oldPromise;
          await s.flush();
        } catch (err) {
          console.warn('[Session:audio] flush failed:', err instanceof Error ? err.message : err);
        }
      } else {
        try { this.session.audio.stopAudio(); } catch {}
      }
      return this.session.audio.createOutputStream({
        format: 'pcm16',
        sampleRate: 24000,
        channels: 1,
      });
    })();

    this.audioOutPromise = next;
    next
      .then((s) => console.log(`[Session:audio] Output stream re-opened (${s.streamId.slice(0, 8)})`))
      .catch((err) => {
        console.error('[Session:audio] re-open after interrupt failed:', err);
        if (this.audioOutPromise === next) this.audioOutPromise = null;
      });
  }

  /** Final cleanup at session end — flush without re-warming. */
  private closeAudioStream(): void {
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
      showText(this.session, 'Session ended');
      this.transition(AppState.IDLE);
    }
  }

  private transition(newState: AppState): void {
    console.log(`[Session] ${this.state} → ${newState}`);
    this.state = newState;
  }

  destroy(reason: string): void {
    console.log(`[Session] Destroying orchestrator (trigger: ${reason}) — cleaning up`);
    this.transition(AppState.IDLE);

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
