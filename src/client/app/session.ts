import type { AppSession } from '@mentra/sdk';
import { AppState } from './state.js';
import { buildSystemPrompt } from './promptTemplate.js';
import { GeminiLiveClient, type GeminiFunctionCall } from '../gemini/liveClient.js';
import { FrameSampler } from '../bridge/frameSampler.js';
import { WeriftWhepClient } from '../bridge/whepClient.js';
import { subscribeMic } from '../mentra/mic.js';
import { speak, showText } from '../mentra/display.js';
import { startLivestream, stopLivestream } from '../mentra/camera.js';
import { ShipMemoryService } from '../shipmemory/service.js';
import { MockShipMemoryService } from '../shipmemory/mock.js';
import type { ContextCard, ContextProvider } from '../shipmemory/types.js';
import type { env as Env } from '../config/env.js';
import { streamState } from '../index.js';

const TOOL_TIMEOUT_MS = 10_000;

export class SessionOrchestrator {
  private state = AppState.IDLE;
  private gemini: GeminiLiveClient;
  private frameSampler: FrameSampler;
  private whepClient: WeriftWhepClient;
  private contextProvider: ContextProvider;
  private card: ContextCard | null = null;

  // Buffer to accumulate transcription text before speaking
  private pendingTranscription = '';
  private transcriptionFlushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private session: AppSession,
    private sessionId: string,
    private config: typeof Env,
  ) {
    this.gemini = new GeminiLiveClient(config.GEMINI_API_KEY, {
      onOutputTranscription: (text) => this.handleOutputTranscription(text),
      onInputTranscription: (text) => console.log(`[User] ${text}`),
      onTurnComplete: () => this.flushTranscription(),
      onInterrupted: () => this.clearPendingTranscription(),
      onToolCall: (calls) => this.handleToolCalls(calls),
      onToolCallCancellation: (ids) => console.log(`[Gemini] Tool calls cancelled: ${ids.join(', ')}`),
      onDisconnected: (reason) => this.handleDisconnect(reason),
      onError: (err) => console.error('[Gemini] Error:', err),
    });

    this.frameSampler = new FrameSampler('scanning');
    this.whepClient = new WeriftWhepClient(640, 480, 1); // 1fps JPEG output from FFmpeg

    // TODO: Switch to ShipMemoryService once camera stream is wired
    // For now, always use mock to test the Gemini voice loop
    this.contextProvider = new MockShipMemoryService();
  }

  /** Stream URL for frame extraction (set after camera starts) */
  private streamUrl: string | null = null;

  async start(): Promise<void> {
    console.log(`[Session] Starting orchestrator (provider: ${this.contextProvider.constructor.name})`);

    // Step 1: Get context (mock for now, QR scanning later)
    this.transition(AppState.SCANNING);
    showText(this.session, 'Loading context…');

    const isMock = this.contextProvider instanceof MockShipMemoryService;
    let card: ContextCard;

    if (isMock) {
      const emptyFrames = (async function* () {})();
      card = await this.contextProvider.scan(emptyFrames);
    } else {
      // TODO: Wire camera frames for QR scanning
      const emptyFrames = (async function* () {})();
      card = await this.contextProvider.scan(emptyFrames);
    }

    this.card = card;
    console.log(`[Session] Got context card: ${card.body.slice(0, 80)}…`);

    // Step 2: Start Gemini voice session (don't wait for camera)
    await this.startGeminiSession(card);

    // Step 3: Start camera in background (non-blocking — video is optional)
    this.startCamera();
  }

  /** Start camera livestream in background — non-blocking, video is optional. */
  private async startCamera(): Promise<void> {
    try {
      streamState.status = 'starting';
      const urls = await startLivestream(this.session);
      this.streamUrl = urls.webrtcUrl ?? null; // Use WebRTC URL for WHEP
      streamState.hlsUrl = urls.hlsUrl;
      streamState.dashUrl = urls.dashUrl;
      streamState.webrtcUrl = urls.webrtcUrl ?? null;
      streamState.status = 'active';
      console.log(`[Session] Camera stream ready — WebRTC: ${this.streamUrl}`);

      // Start server-side WHEP frame extraction if WebRTC URL is available
      if (this.streamUrl) {
        this.startVideoStream();
      } else {
        console.warn('[Session] No WebRTC URL — video frames unavailable');
      }
    } catch (err) {
      console.warn('[Session] Camera stream failed, continuing voice-only:', err);
      streamState.status = 'idle';
    }
  }

  private async startGeminiSession(card: ContextCard): Promise<void> {
    this.transition(AppState.SESSION);
    showText(this.session, 'Connecting to Gemini…');

    const systemPrompt = buildSystemPrompt(card);
    await this.gemini.connect(systemPrompt, card);

    showText(this.session, 'Ready — speak to begin');
    console.log('[Session] Gemini Live session active');

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

    // Switch frame sampler to session mode (1fps for Gemini video)
    this.frameSampler.switchMode('session');
  }

  /** Consume camera via WHEP (werift) and send JPEG frames to Gemini. */
  private async startVideoStream(): Promise<void> {
    if (!this.streamUrl) return;
    console.log(`[Session] Starting WHEP video extraction from ${this.streamUrl}`);

    let frameCount = 0;
    let lastGeminiSend = 0;
    const FRAME_INTERVAL_MS = 1000; // 1fps continuous to Gemini (matches Android client)

    try {
      for await (const { jpeg } of this.whepClient.connect(this.streamUrl)) {
        if (this.state !== AppState.SESSION && this.state !== AppState.SCANNING) break;

        frameCount++;
        streamState.latestJpeg = jpeg;
        streamState.latestJpegTime = Date.now();
        streamState.frameCount = frameCount;

        // Send frames to Gemini at ~1fps continuously (like Android client)
        // so Gemini always has recent visual context when a turn is processed
        const now = Date.now();
        if (this.state === AppState.SESSION && (now - lastGeminiSend) >= FRAME_INTERVAL_MS) {
          this.gemini.sendVideoFrame(jpeg);
          lastGeminiSend = now;
        }

        if (frameCount % 30 === 1) {
          console.log(`[Session:video] Frame #${frameCount} captured (${(jpeg.length / 1024).toFixed(1)}KB)`);
        }
      }
    } catch (err) {
      console.error('[Session] WHEP video stream error:', err);
    }
  }

  private handleOutputTranscription(text: string): void {
    this.pendingTranscription += text;

    // Debounce: flush after 300ms of no new text
    if (this.transcriptionFlushTimer) clearTimeout(this.transcriptionFlushTimer);
    this.transcriptionFlushTimer = setTimeout(() => this.flushTranscription(), 300);
  }

  private flushTranscription(): void {
    if (this.transcriptionFlushTimer) {
      clearTimeout(this.transcriptionFlushTimer);
      this.transcriptionFlushTimer = null;
    }
    const text = this.pendingTranscription.trim();
    if (!text) return;
    this.pendingTranscription = '';

    console.log(`[Gemini→TTS] ${text}`);
    speak(this.session, text);
  }

  private clearPendingTranscription(): void {
    this.pendingTranscription = '';
    if (this.transcriptionFlushTimer) {
      clearTimeout(this.transcriptionFlushTimer);
      this.transcriptionFlushTimer = null;
    }
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
    const res = await fetch(this.card!.execute_url!, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: call.name,
        arguments: call.args,
        session_id: this.card!.session_id,
      }),
      signal: AbortSignal.timeout(TOOL_TIMEOUT_MS),
    });

    if (!res.ok) {
      throw new Error(`Tool API returned ${res.status}: ${await res.text()}`);
    }

    const json = await res.json() as Record<string, unknown>;
    return (json.result as Record<string, unknown>) ?? json;
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

  destroy(): void {
    console.log('[Session] Destroying orchestrator — cleaning up Gemini + WHEP + camera');
    this.gemini.disconnect();
    this.whepClient.stop();
    this.frameSampler.destroy();
    this.clearPendingTranscription();
    stopLivestream(this.session).catch(() => {});
    this.transition(AppState.IDLE);
  }
}
