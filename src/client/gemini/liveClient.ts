import WebSocket from 'ws';
import type { ContextCard } from '../shipmemory/types.js';
import { buildSetupMessage } from './setupMessage.js';
import { pcmToBase64, jpegToBase64 } from './audioCodec.js';

const WS_BASE_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

const CONNECT_TIMEOUT_MS = 15_000;

export interface GeminiFunctionCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface GeminiLiveCallbacks {
  onSetupComplete?: () => void;
  onAudioReceived?: (pcmBase64: string) => void;
  onOutputTranscription?: (text: string) => void;
  onInputTranscription?: (text: string) => void;
  onTurnComplete?: () => void;
  onInterrupted?: () => void;
  onToolCall?: (calls: GeminiFunctionCall[]) => void;
  onToolCallCancellation?: (ids: string[]) => void;
  onDisconnected?: (reason?: string) => void;
  onError?: (err: Error) => void;
}

/**
 * Gemini Live WebSocket client.
 * Ported from the Android GeminiLiveService.kt.
 */
export class GeminiLiveClient {
  private ws: WebSocket | null = null;
  private ready = false;
  private audioSendCount = 0;
  private audioSendBytes = 0;
  private lastAudioLogTime = 0;
  private lastAudioSendTime = 0;
  private audioStreamEndTimer: ReturnType<typeof setTimeout> | null = null;
  private audioStreamActive = false;

  /** Optional callback that returns the latest JPEG frame + its capture time + frame number. */
  latestFrameProvider: (() => { jpeg: Buffer | null; capturedAt: number; frameNum: number }) | null = null;

  constructor(
    private apiKey: string,
    private callbacks: GeminiLiveCallbacks = {},
  ) {}

  /** Connect and send the setup message. Resolves when setupComplete is received. */
  async connect(systemPrompt: string, card: ContextCard): Promise<void> {
    const url = `${WS_BASE_URL}?key=${this.apiKey}`;
    console.log('[Gemini] Connecting to Gemini Live…');

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.disconnect();
        reject(new Error('Gemini Live connection timed out'));
      }, CONNECT_TIMEOUT_MS);

      this.ws = new WebSocket(url);

      this.ws.on('open', () => {
        const setupMsg = buildSetupMessage(systemPrompt, card);
        this.ws!.send(JSON.stringify(setupMsg));
        console.log('[Gemini] Setup message sent');
      });

      this.ws.on('message', (data) => {
        try {
          const raw = data.toString();
          // Log first 200 chars of every message for debugging
          const keys = Object.keys(JSON.parse(raw));
          console.log(`[Gemini:ws] Message received, keys: [${keys.join(', ')}]`);
          const msg = JSON.parse(raw);
          this.handleMessage(msg, () => {
            clearTimeout(timeout);
            resolve();
          });
        } catch (err) {
          console.error('[Gemini] Failed to parse message:', err);
        }
      });

      this.ws.on('close', (code, reason) => {
        this.ready = false;
        const msg = `WebSocket closed: ${code} ${reason.toString()}`;
        console.log(`[Gemini] ${msg}`);
        this.callbacks.onDisconnected?.(msg);
      });

      this.ws.on('error', (err) => {
        clearTimeout(timeout);
        console.error('[Gemini] WebSocket error:', err);
        this.callbacks.onError?.(err);
        reject(err);
      });
    });
  }

  private handleMessage(msg: Record<string, unknown>, onSetup: () => void): void {
    // Setup complete
    if ('setupComplete' in msg) {
      this.ready = true;
      console.log('[Gemini] Setup complete — session ready');
      this.callbacks.onSetupComplete?.();
      onSetup();
      return;
    }

    // Go away (server closing)
    if ('goAway' in msg) {
      console.warn('[Gemini] Server sent goAway:', msg.goAway);
      return;
    }

    // Tool call
    if ('toolCall' in msg) {
      const tc = msg.toolCall as { functionCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }> };
      if (tc.functionCalls) {
        this.callbacks.onToolCall?.(tc.functionCalls);
      }
      return;
    }

    // Tool call cancellation
    if ('toolCallCancellation' in msg) {
      const tcc = msg.toolCallCancellation as { ids?: string[] };
      if (tcc.ids) {
        this.callbacks.onToolCallCancellation?.(tcc.ids);
      }
      return;
    }

    // Server content (audio, transcriptions, turn status)
    if ('serverContent' in msg) {
      const sc = msg.serverContent as Record<string, unknown>;

      // Audio data in modelTurn
      const modelTurn = sc.modelTurn as { parts?: Array<{ inlineData?: { data: string } }> } | undefined;
      if (modelTurn?.parts) {
        for (const part of modelTurn.parts) {
          if (part.inlineData?.data) {
            console.log(`[Gemini:recv] Audio chunk received (${(part.inlineData.data.length * 0.75 / 1024).toFixed(1)}KB)`);
            this.callbacks.onAudioReceived?.(part.inlineData.data);
          }
        }
      }

      // Transcriptions
      const inputTx = sc.inputTranscription as { text?: string } | undefined;
      if (inputTx?.text) {
        console.log(`[Gemini:recv] Input transcription: "${inputTx.text}"`);
        this.callbacks.onInputTranscription?.(inputTx.text);
      }

      const outputTx = sc.outputTranscription as { text?: string } | undefined;
      if (outputTx?.text) {
        console.log(`[Gemini:recv] Output transcription: "${outputTx.text}"`);
        this.callbacks.onOutputTranscription?.(outputTx.text);
      }

      // Turn complete
      if (sc.turnComplete) {
        console.log('[Gemini:recv] Turn complete');
        this.callbacks.onTurnComplete?.();
      }

      // Interrupted
      if (sc.interrupted) {
        console.log('[Gemini:recv] Interrupted');
        this.callbacks.onInterrupted?.();
      }

      return;
    }
  }

  /** Send raw PCM audio (16kHz mono) to Gemini. */
  sendAudio(pcm: ArrayBufferLike): void {
    if (!this.ready || !this.ws) {
      if (!this.ready) console.warn('[Gemini:audio] Dropping audio — not ready');
      return;
    }
    const b64 = pcmToBase64(pcm);
    this.audioSendCount++;
    this.audioSendBytes += pcm.byteLength;

    const now = Date.now();

    // Log every 5 seconds
    if (now - this.lastAudioLogTime >= 5000) {
      console.log(`[Gemini:audio] Sent ${this.audioSendCount} chunks, ${(this.audioSendBytes / 1024).toFixed(1)}KB total to Gemini (stream=${this.audioStreamActive ? 'active' : 'idle'})`);
      this.lastAudioLogTime = now;
    }

    // Mark audio stream as active — send a fresh frame at speech start
    if (!this.audioStreamActive) {
      this.audioStreamActive = true;
      const latest = this.latestFrameProvider?.();
      if (latest?.jpeg) {
        const ageMs = Date.now() - latest.capturedAt;
        console.log(`[Gemini:audio] Speech start — sending frame #${latest.frameNum} (age: ${ageMs}ms, ${(latest.jpeg.length / 1024).toFixed(1)}KB)`);
        this.sendVideoFrame(latest.jpeg, latest.frameNum);
      } else {
        console.log('[Gemini:audio] Speech start — no frame available');
      }
    }
    this.lastAudioSendTime = now;

    // Reset the audioStreamEnd timer — send it after 1.5s of silence
    if (this.audioStreamEndTimer) clearTimeout(this.audioStreamEndTimer);
    this.audioStreamEndTimer = setTimeout(() => this.sendAudioStreamEnd(), 1500);

    this.ws.send(JSON.stringify({
      realtimeInput: {
        audio: {
          mimeType: 'audio/pcm;rate=16000',
          data: b64,
        },
      },
    }));
  }

  /** Signal to Gemini that the audio stream has paused — flush buffered audio. */
  private sendAudioStreamEnd(): void {
    if (!this.ready || !this.ws || !this.audioStreamActive) return;
    this.audioStreamActive = false;

    // Send the latest frame right before audioStreamEnd so Gemini
    // includes it in the current turn's processing.
    const latest = this.latestFrameProvider?.();
    if (latest?.jpeg) {
      const ageMs = Date.now() - latest.capturedAt;
      console.log(`[Gemini:audio] Sending frame #${latest.frameNum} before audioStreamEnd — age: ${ageMs}ms, size: ${(latest.jpeg.length / 1024).toFixed(1)}KB`);
      this.sendVideoFrame(latest.jpeg, latest.frameNum);
    }

    console.log('[Gemini:audio] Sending audioStreamEnd (silence detected)');
    this.ws.send(JSON.stringify({
      realtimeInput: {
        audioStreamEnd: true,
      },
    }));
  }

  private videoFramesSent = 0;
  private lastSentFrameId: number | string | null = null;
  private skippedStaleFrames = 0;

  /**
   * Send a JPEG video frame to Gemini.
   *
   * If `frameId` is supplied and matches the last frame we already sent, the
   * call is a no-op. This prevents resending a stale `latestJpeg` during speech
   * start/end when the underlying camera stream has stopped producing frames.
   */
  sendVideoFrame(jpeg: Buffer, frameId?: number | string): void {
    if (!this.ready || !this.ws) return;
    if (frameId != null && frameId === this.lastSentFrameId) {
      this.skippedStaleFrames++;
      if (this.skippedStaleFrames === 1 || this.skippedStaleFrames % 10 === 0) {
        console.log(`[Gemini:video] Skipping stale frame #${frameId} (skipped=${this.skippedStaleFrames})`);
      }
      return;
    }
    this.lastSentFrameId = frameId ?? null;
    this.videoFramesSent++;
    if (this.videoFramesSent <= 3 || this.videoFramesSent % 10 === 0) {
      console.log(`[Gemini:video] Sending frame #${this.videoFramesSent} (${(jpeg.length / 1024).toFixed(1)}KB, ${jpegToBase64(jpeg).length} b64 chars)`);
    }
    this.ws.send(JSON.stringify({
      realtimeInput: {
        video: {
          mimeType: 'image/jpeg',
          data: jpegToBase64(jpeg),
        },
      },
    }));
  }

  /** Send a tool response back to Gemini. */
  sendToolResponse(id: string, name: string, response: Record<string, unknown>): void {
    if (!this.ready || !this.ws) return;
    this.ws.send(JSON.stringify({
      toolResponse: {
        functionResponses: [{ id, name, response }],
      },
    }));
  }

  /** Send a text message (for text-based interaction, not primary path). */
  sendText(text: string): void {
    if (!this.ready || !this.ws) return;
    this.ws.send(JSON.stringify({
      clientContent: {
        turns: [{ role: 'user', parts: [{ text }] }],
      },
    }));
  }

  disconnect(): void {
    this.ready = false;
    if (this.audioStreamEndTimer) {
      clearTimeout(this.audioStreamEndTimer);
      this.audioStreamEndTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  get isReady(): boolean {
    return this.ready;
  }
}
