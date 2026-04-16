import type { AppSession } from '@mentra/sdk';
import { AppState } from './state.js';
import { buildSystemPrompt } from './promptTemplate.js';
import { GeminiLiveClient, type GeminiFunctionCall } from '../gemini/liveClient.js';
import { FrameSampler } from '../bridge/frameSampler.js';
import { StreamFrameExtractor } from '../bridge/whepClient.js';
import { subscribeMic } from '../mentra/mic.js';
import { speak, showText } from '../mentra/display.js';
import { ShipMemoryService } from '../shipmemory/service.js';
import { MockShipMemoryService } from '../shipmemory/mock.js';
import type { ContextCard, ContextProvider, Frame } from '../shipmemory/types.js';
import type { env as Env } from '../config/env.js';

const TOOL_TIMEOUT_MS = 10_000;

export class SessionOrchestrator {
  private state = AppState.IDLE;
  private gemini: GeminiLiveClient;
  private frameSampler: FrameSampler;
  private frameExtractor: StreamFrameExtractor;
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
    this.frameExtractor = new StreamFrameExtractor();

    // TODO: Switch to ShipMemoryService once camera stream is wired
    // For now, always use mock to test the Gemini voice loop
    this.contextProvider = new MockShipMemoryService();
  }

  async start(): Promise<void> {
    console.log(`[Session] Starting orchestrator (provider: ${this.contextProvider.constructor.name})`);
    this.transition(AppState.SCANNING);
    showText(this.session, 'Loading context…');

    // Mock provider ignores frames, real provider will need the camera stream
    const emptyFrames = (async function* () {})();
    const card = await this.contextProvider.scan(emptyFrames);
    this.card = card;
    console.log(`[Session] Got context card: ${card.body.slice(0, 80)}…`);

    // Transition to active session
    await this.startGeminiSession(card);
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

    // Switch frame sampler to session mode (1fps for Gemini video)
    this.frameSampler.switchMode('session');
  }

  /**
   * Creates an async iterable of frames, filtered through the FrameSampler.
   * In scanning mode: ~3fps filtered frames for QR detection.
   * In session mode: ~1fps frames for Gemini video input.
   */
  private async *createFilteredFrameStream(): AsyncGenerator<Frame> {
    // TODO: Wire actual camera stream URL from Mentra session
    // For now, this is a placeholder that yields from the frame extractor
    // once a stream URL is available.
    const streamUrl = 'rtmp://localhost/live/stream'; // placeholder

    for await (const frame of this.frameExtractor.extract(streamUrl)) {
      const result = this.frameSampler.shouldProcess(frame);
      if (!result.accept) continue;

      if (this.state === AppState.SESSION) {
        // In session mode, also send frames to Gemini as video context
        // TODO: Encode frame as JPEG and send via gemini.sendVideoFrame()
      }

      yield frame;
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
    console.log('[Session] Destroying orchestrator — cleaning up Gemini + frame pipeline');
    this.gemini.disconnect();
    this.frameExtractor.stop();
    this.frameSampler.destroy();
    this.clearPendingTranscription();
    this.transition(AppState.IDLE);
  }
}
