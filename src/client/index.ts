import { AppServer, AppSession } from '@mentra/sdk';
import { streamSSE } from 'hono/streaming';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from './config/env.js';
import { SessionOrchestrator } from './app/session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Transcript event bus for the webview SSE stream. Orchestrator pushes;
 * /api/transcript/stream subscribers drain. Events:
 *   { type: 'user', text }         — user transcription chunk
 *   { type: 'ai',   text }         — Gemini output transcription chunk
 *   { type: 'turn_complete' }      — Gemini finished its reply
 */
export const transcriptEvents = new EventEmitter();
transcriptEvents.setMaxListeners(50);

/** Shared stream state so the /webview route can access current URLs */
export const streamState: {
  hlsUrl: string | null;
  webrtcUrl: string | null;
  previewUrl: string | null;
  dashUrl: string | null;
  status: 'idle' | 'starting' | 'active' | 'reconnecting' | 'error';
  latestJpeg: Buffer | null;
  latestJpegTime: number;
  frameCount: number;
  scanStatus: 'idle' | 'active' | 'timeout';
  scanStartedAt: number | null;
  sessionEndReason: string | null;
} = {
  hlsUrl: null,
  webrtcUrl: null,
  previewUrl: null,
  dashUrl: null,
  status: 'idle',
  latestJpeg: null,
  latestJpegTime: 0,
  frameCount: 0,
  scanStatus: 'idle',
  scanStartedAt: null,
  sessionEndReason: null,
};

const DISCONNECT_GRACE_MS = 30_000;

class ShipMemoryApp extends AppServer {
  private orchestrators = new Map<string, SessionOrchestrator>();
  private startedSessions = new Set<string>();
  private pendingDestroy = new Map<string, NodeJS.Timeout>();

  constructor() {
    super({
      packageName: env.PACKAGE_NAME,
      apiKey: env.MENTRAOS_API_KEY,
      port: env.PORT,
    });
    this.setupWebviewRoutes();
  }

  private setupWebviewRoutes(): void {
    // Stream status API (polled by the webview page)
    this.get('/api/stream', (c) =>
      c.json({
        hlsUrl: streamState.hlsUrl,
        webrtcUrl: streamState.webrtcUrl,
        previewUrl: streamState.previewUrl,
        dashUrl: streamState.dashUrl,
        status: streamState.status,
        frameCount: streamState.frameCount,
        iframeUrl: streamState.previewUrl,
      }),
    );

    // Session state for the webview — lets the UI show a Start button
    // until the user explicitly triggers orchestrator.start().
    this.get('/api/state', (c) => {
      const sessionId = this.orchestrators.keys().next().value ?? null;
      const orchestrator = sessionId ? this.orchestrators.get(sessionId) : null;
      const appState = orchestrator ? orchestrator.getState() : 'IDLE';
      const started = sessionId ? this.startedSessions.has(sessionId) : false;
      const canRescan = appState === 'SCANNING' && streamState.scanStatus === 'timeout';
      const canRestartStream = appState === 'SESSION';
      const canStopSession = appState === 'SESSION';
      return c.json({
        sessionId,
        hasSession: !!sessionId,
        started,
        streamStatus: streamState.status,
        appState,
        scanStatus: streamState.scanStatus,
        scanStartedAt: streamState.scanStartedAt,
        sessionEndReason: streamState.sessionEndReason,
        canRescan,
        canRestartStream,
        canStopSession,
      });
    });

    // Manual start trigger. Until the user POSTs here, the orchestrator
    // exists but hasn't touched camera / stream / WHEP. This lets the
    // user wait out any switching_clouds churn before committing
    // resources.
    this.post('/api/start', (c) => {
      const sessionId = this.orchestrators.keys().next().value ?? null;
      if (!sessionId) {
        return c.json({ error: 'No active session. Open the app on your glasses first.' }, 404);
      }
      if (this.startedSessions.has(sessionId)) {
        return c.json({ status: 'already-started', sessionId });
      }
      const orchestrator = this.orchestrators.get(sessionId);
      if (!orchestrator) {
        return c.json({ error: 'Orchestrator missing for session' }, 404);
      }
      this.startedSessions.add(sessionId);
      streamState.sessionEndReason = null;
      console.log(`[ShipMemory] User triggered start via webview for ${sessionId}`);
      // Fire-and-forget. Errors get caught and run cleanupSession.
      orchestrator.start().catch((err) => {
        console.error(`[ShipMemory] orchestrator.start() failed for ${sessionId} — cleaning up`, err);
        this.cleanupSession(sessionId, 'start-failed');
      });
      return c.json({ status: 'starting', sessionId });
    });

    // Manual rescan: valid only when a scan has timed out.
    this.post('/api/rescan', (c) => {
      const sessionId = this.orchestrators.keys().next().value ?? null;
      const orchestrator = sessionId ? this.orchestrators.get(sessionId) : null;
      if (!orchestrator) return c.json({ error: 'No active session' }, 404);
      if (orchestrator.getState() !== 'SCANNING' || streamState.scanStatus !== 'timeout') {
        return c.json({ error: `Cannot rescan in state=${orchestrator.getState()} scanStatus=${streamState.scanStatus}` }, 409);
      }
      console.log(`[ShipMemory] User triggered rescan for ${sessionId}`);
      orchestrator.rescan().catch((err) => {
        console.error(`[ShipMemory] rescan failed for ${sessionId}:`, err);
      });
      return c.json({ status: 'rescanning', sessionId });
    });

    // Manual stream restart: valid during SESSION. Tears the WHEP/Cloudflare
    // stream down and spins a fresh one without touching Gemini.
    this.post('/api/restart-stream', (c) => {
      const sessionId = this.orchestrators.keys().next().value ?? null;
      const orchestrator = sessionId ? this.orchestrators.get(sessionId) : null;
      if (!orchestrator) return c.json({ error: 'No active session' }, 404);
      if (orchestrator.getState() !== 'SESSION') {
        return c.json({ error: `Cannot restart stream in state=${orchestrator.getState()}` }, 409);
      }
      console.log(`[ShipMemory] User triggered stream restart for ${sessionId}`);
      orchestrator.restartStream().catch((err) => {
        console.error(`[ShipMemory] restartStream failed for ${sessionId}:`, err);
        streamState.status = 'error';
      });
      return c.json({ status: 'restarting', sessionId });
    });

    // User-initiated stop of the Gemini session. Ends Gemini, closes
    // audio, and drops the orchestrator back into scan mode so the next
    // QR starts a fresh session. Leaves the orchestrator + camera + WHEP
    // loop alive.
    this.post('/api/stop-session', (c) => {
      const sessionId = this.orchestrators.keys().next().value ?? null;
      const orchestrator = sessionId ? this.orchestrators.get(sessionId) : null;
      if (!orchestrator) return c.json({ error: 'No active session' }, 404);
      if (orchestrator.getState() !== 'SESSION') {
        return c.json({ error: `Cannot stop session in state=${orchestrator.getState()}` }, 409);
      }
      console.log(`[ShipMemory] User stopped Gemini session for ${sessionId}`);
      orchestrator.stopSession().catch((err) => {
        console.error(`[ShipMemory] stopSession failed for ${sessionId}:`, err);
      });
      return c.json({ status: 'stopping', sessionId });
    });

    // SSE stream of Gemini transcription events (user speech + AI reply).
    // No history — subscribers see events from the moment they connect.
    this.get('/api/transcript/stream', (c) =>
      streamSSE(c, async (stream) => {
        await stream.writeSSE({ data: '', retry: 2000 });
        const listener = (ev: unknown) => {
          stream.writeSSE({ data: JSON.stringify(ev) }).catch(() => {});
        };
        transcriptEvents.on('event', listener);
        await new Promise<void>((resolve) => {
          stream.onAbort(() => {
            transcriptEvents.off('event', listener);
            resolve();
          });
        });
      }),
    );

    // Latest camera frame as JPEG (for debugging)
    this.get('/api/frame', (c) => {
      if (!streamState.latestJpeg) {
        return c.text('No frame available yet', 404);
      }
      // Use raw Response — Hono's c.body() typing rejects Node Buffer because
      // Buffer's ArrayBufferLike includes SharedArrayBuffer.
      return new Response(new Uint8Array(streamState.latestJpeg), {
        headers: {
          'Content-Type': 'image/jpeg',
          'Cache-Control': 'no-cache, no-store',
        },
      });
    });

    // Live frame preview page (auto-refreshes)
    this.get('/frame', (c) => c.html(FRAME_PREVIEW_HTML));

    // Webview page
    this.get('/webview', (c) => c.html(WEBVIEW_HTML));

    // SFX hosting — bundled MP3s served back to the glasses via session.audio.playAudio.
    // Self-contained: no external host required.
    this.get('/sfx/:name', (c) => {
      const name = c.req.param('name');
      if (!/^[a-z0-9-]+\.mp3$/i.test(name)) return c.text('not found', 404);
      const file = path.join(__dirname, 'assets', 'sfx', name);
      if (!fs.existsSync(file)) return c.text('not found', 404);
      return new Response(new Uint8Array(fs.readFileSync(file)), {
        headers: {
          'Content-Type': 'audio/mpeg',
          'Cache-Control': 'public, max-age=86400',
        },
      });
    });

    console.log('[ShipMemory] Routes: /webview (stream), /frame (camera preview), /api/frame (raw JPEG), /sfx/:name (bundled audio)');
  }

  protected async onSession(session: AppSession, sessionId: string, userId: string): Promise<void> {
    console.log(`[ShipMemory] New session: ${sessionId} user: ${userId}`);

    // If a pending grace-window destroy is in flight for this sessionId,
    // cancel it — a new session (or reconnect) took its place.
    this.clearPendingDestroy(sessionId);

    // Preemptive replace: during Mentra switching_clouds handoff, the new
    // session webhook can fire before the old session's onStop/onDisconnected.
    // Destroy any leftover orchestrator synchronously so its late-firing
    // events become no-ops under the identity guard below.
    const existing = this.orchestrators.get(sessionId);
    if (existing) {
      console.warn(`[ShipMemory] Replacing existing orchestrator for ${sessionId} — likely switching_clouds`);
      existing.destroy('replaced:switching_clouds');
      this.orchestrators.delete(sessionId);
    }

    session.layouts.showTextWall('Waiting for start — tap on phone');

    // Single orchestrator per Mentra session. When Gemini disconnects the
    // orchestrator auto-returns to SCANNING and starts a fresh scan, so
    // we never have to recreate it from here — only onStop / grace-expired
    // tear it down.
    const orchestrator = new SessionOrchestrator(session, sessionId, env);
    this.orchestrators.set(sessionId, orchestrator);
    this.startedSessions.delete(sessionId);

    // Identity-match guard: onDisconnected can fire LATE for an old session
    // whose sessionId was already reused by a new orchestrator (Mentra
    // switching_clouds). Without this check, the old session's disconnect
    // destroys the new orchestrator mid-init.
    session.events.onDisconnected((data) => {
      if (this.orchestrators.get(sessionId) !== orchestrator) {
        console.log(`[ShipMemory] Ignoring stale onDisconnected for ${sessionId} — orchestrator replaced`);
        return;
      }
      console.log(
        `[ShipMemory] Session WebSocket disconnected: ${sessionId} — deferring cleanup ${DISCONNECT_GRACE_MS / 1000}s for possible reconnect`,
        data,
      );
      // Grace window: glasses WiFi blip / brief drops shouldn't tear down
      // Gemini + stream. Only destroy if no reconnect within DISCONNECT_GRACE_MS.
      // onConnected / new onSession / onStop all cancel the timer.
      if (this.pendingDestroy.has(sessionId)) return;
      const timer = setTimeout(() => {
        this.pendingDestroy.delete(sessionId);
        if (this.orchestrators.get(sessionId) !== orchestrator) return;
        console.log(`[ShipMemory] Grace window expired for ${sessionId} — cleaning up`);
        this.cleanupSession(sessionId, 'grace-expired');
      }, DISCONNECT_GRACE_MS);
      this.pendingDestroy.set(sessionId, timer);
    });
    session.events.onConnected(() => {
      if (this.pendingDestroy.has(sessionId)) {
        console.log(`[ShipMemory] Session ${sessionId} reconnected — cancelling pending cleanup`);
        this.clearPendingDestroy(sessionId);
      }
    });
    // onError is observational only. The SDK fires it for every internal
    // WebSocket send failure after a drop, so using it to trigger cleanup
    // causes a flood of redundant destroy calls. Lifecycle is handled by
    // onStop + onDisconnected.
    session.events.onError((err) => {
      console.error(`[ShipMemory] Session error: ${sessionId}`, err instanceof Error ? err.message : err);
    });

    // Don't auto-start. The orchestrator is created and wired, but camera /
    // WHEP / Gemini stay dormant until the user taps Start in the webview.
    // That way Mentra's switching_clouds churn (duplicate session_request
    // webhooks that tear down and recreate the session) can settle without
    // burning any Cloudflare streams.
    console.log(`[ShipMemory] Session ${sessionId} ready — waiting for user to tap Start in webview`);
  }

  protected async onStop(sessionId: string, userId: string, reason: string): Promise<void> {
    console.log(`[ShipMemory] Session stop requested: ${sessionId} reason: ${reason}`);
    // Mentra bug #2526: `user_disabled` is often reported for platform-side drops
    // where the user did nothing. Flag it so we don't waste time suspecting the user.
    if (reason === 'user_disabled') {
      console.warn(
        '[ShipMemory] reason=user_disabled may be spurious — see MentraOS#2526 ' +
        '(triggerStopByPackageName mis-reports platform drops as user action)',
      );
    }
    this.cleanupSession(sessionId, `onStop:${reason}`);
  }

  private clearPendingDestroy(sessionId: string): void {
    const pending = this.pendingDestroy.get(sessionId);
    if (pending) {
      clearTimeout(pending);
      this.pendingDestroy.delete(sessionId);
    }
  }

  private cleanupSession(sessionId: string, trigger: string): void {
    this.clearPendingDestroy(sessionId);
    const orchestrator = this.orchestrators.get(sessionId);
    if (orchestrator) {
      orchestrator.destroy(trigger);
      this.orchestrators.delete(sessionId);
    }
    this.startedSessions.delete(sessionId);
    streamState.hlsUrl = null;
    streamState.webrtcUrl = null;
    streamState.previewUrl = null;
    streamState.dashUrl = null;
    streamState.status = 'idle';
    streamState.latestJpeg = null;
    streamState.latestJpegTime = 0;
    streamState.frameCount = 0;
    streamState.scanStatus = 'idle';
    streamState.scanStartedAt = null;
    // NOTE: sessionEndReason is deliberately NOT cleared here — we want the
    // next /api/state poll to show the reason so the webview can render its
    // "Previous session ended: X" banner until the user taps Start.
  }
}

const FRAME_PREVIEW_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ShipMemory — Camera Frame Preview</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #0a0a0a;
      color: #fff;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
    }
    #frame {
      max-width: 90vw;
      max-height: 80vh;
      border: 2px solid #333;
      border-radius: 8px;
    }
    #info {
      margin-top: 12px;
      font-size: 0.85rem;
      color: #888;
    }
    #status {
      font-size: 1.2rem;
      color: #666;
    }
  </style>
</head>
<body>
  <div id="status">Waiting for first frame...</div>
  <img id="frame" style="display:none" alt="Camera frame" />
  <div id="info"></div>
  <script>
    const img = document.getElementById('frame');
    const status = document.getElementById('status');
    const info = document.getElementById('info');
    let count = 0;
    let lastSize = 0;

    async function refresh() {
      try {
        const res = await fetch('/api/frame', { cache: 'no-store' });
        if (res.ok) {
          const blob = await res.blob();
          lastSize = blob.size;
          const url = URL.createObjectURL(blob);
          img.onload = () => URL.revokeObjectURL(url);
          img.src = url;
          img.style.display = 'block';
          status.style.display = 'none';
          count++;
          info.textContent = 'Frame #' + count + ' | ' + (lastSize / 1024).toFixed(1) + 'KB | refreshing every 500ms';
        }
      } catch (e) {}
      setTimeout(refresh, 500);
    }
    refresh();
  </script>
</body>
</html>`;

const WEBVIEW_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ShipMemory</title>
  <style>
    :root {
      --bg: #0a0a0a;
      --panel: #111827;
      --panel-2: #0f172a;
      --border: #1f2937;
      --text: #e5e7eb;
      --muted: #9ca3af;
      --dim: #6b7280;
      --accent: #10b981;
      --accent-2: #34d399;
      --amber: #f59e0b;
      --amber-bg: #78350f;
      --amber-fg: #fde68a;
      --red: #ef4444;
      --red-bg: #7f1d1d;
      --red-fg: #fecaca;
      --neutral-bg: #1f2937;
      --neutral-fg: #9ca3af;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { height: 100%; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    /* ---------------- Start screen ---------------- */
    #start-screen {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 32px 24px;
      gap: 28px;
    }
    #start-screen .brand {
      font-size: 1.7rem;
      font-weight: 700;
      letter-spacing: -0.01em;
      color: var(--text);
    }
    #start-screen .subtitle {
      color: var(--muted);
      font-size: 0.95rem;
      text-align: center;
      margin-top: -16px;
    }
    #start-screen ol {
      list-style: none;
      counter-reset: step;
      display: flex;
      flex-direction: column;
      gap: 14px;
      max-width: 320px;
      width: 100%;
    }
    #start-screen ol li {
      counter-increment: step;
      display: flex;
      align-items: flex-start;
      gap: 12px;
      padding: 12px 14px;
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 12px;
      color: var(--text);
      font-size: 0.95rem;
      line-height: 1.4;
    }
    #start-screen ol li::before {
      content: counter(step);
      flex: 0 0 24px;
      height: 24px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--accent);
      color: #042014;
      font-weight: 700;
      font-size: 0.8rem;
      border-radius: 999px;
    }
    #start-screen #start-status {
      color: var(--muted);
      font-size: 0.9rem;
      min-height: 1.2em;
      text-align: center;
    }
    #start-btn {
      padding: 16px 56px;
      font-size: 1.2rem;
      font-weight: 700;
      background: var(--accent);
      color: #042014;
      border: none;
      border-radius: 14px;
      cursor: pointer;
      box-shadow: 0 6px 20px rgba(16, 185, 129, 0.25);
      transition: transform 0.1s, opacity 0.2s;
    }
    #start-btn:hover { transform: translateY(-1px); }
    #start-btn:active { transform: translateY(0); }
    #start-btn:disabled { opacity: 0.45; cursor: not-allowed; transform: none; box-shadow: none; }

    /* ---------------- Main screen ---------------- */
    #main-screen { flex: 1; display: none; flex-direction: column; min-height: 0; }

    #toolbar {
      flex: 0 0 auto;
      padding: 14px 18px;
      background: var(--panel);
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      gap: 14px;
    }
    #status-dot {
      width: 10px;
      height: 10px;
      border-radius: 999px;
      flex: 0 0 auto;
      background: var(--neutral-fg);
      box-shadow: 0 0 0 0 currentColor;
    }
    #status-dot.pulsing {
      animation: statusPulse 1.4s ease-in-out infinite;
    }
    @keyframes statusPulse {
      0%, 100% { box-shadow: 0 0 0 0 currentColor; opacity: 0.85; }
      50% { box-shadow: 0 0 0 6px rgba(255, 255, 255, 0); opacity: 1; }
    }
    #status-text {
      display: flex;
      flex-direction: column;
      min-width: 0;
      flex: 1;
    }
    #status-label {
      font-size: 1rem;
      font-weight: 600;
      color: var(--text);
      line-height: 1.2;
    }
    #status-detail {
      font-size: 0.8rem;
      color: var(--muted);
      margin-top: 2px;
      line-height: 1.2;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    #status-chip {
      padding: 4px 10px;
      border-radius: 999px;
      font-size: 0.7rem;
      font-weight: 700;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      background: var(--neutral-bg);
      color: var(--neutral-fg);
      flex: 0 0 auto;
    }

    #action-bar {
      flex: 0 0 auto;
      padding: 12px 16px;
      display: flex;
      gap: 10px;
      justify-content: center;
      background: var(--panel-2);
      border-bottom: 1px solid var(--border);
      min-height: 60px;
    }
    #action-bar button {
      padding: 10px 18px;
      font-size: 0.9rem;
      font-weight: 600;
      border: 1px solid var(--border);
      border-radius: 10px;
      cursor: pointer;
      background: var(--panel);
      color: var(--text);
      transition: background 0.15s, border-color 0.15s;
    }
    #action-bar button:hover { background: #1e293b; }
    #action-bar button:disabled { opacity: 0.4; cursor: not-allowed; }
    #action-bar button.primary {
      background: var(--red-bg);
      color: var(--red-fg);
      border-color: #991b1b;
    }
    #action-bar button.primary:hover { background: #991b1b; }
    #action-bar button.warn {
      background: var(--amber-bg);
      color: var(--amber-fg);
      border-color: #92400e;
    }
    #action-bar button.warn:hover { background: #92400e; }
    #action-bar .empty { color: var(--dim); font-size: 0.85rem; padding: 10px 0; }

    #viewer {
      flex: 1;
      position: relative;
      overflow: hidden;
      background: #000;
      min-height: 0;
    }
    #iframe-player { width: 100%; height: 100%; display: none; }
    #preview-iframe { width: 100%; height: 100%; border: none; }
    #viewer-placeholder {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--dim);
      font-size: 0.95rem;
      text-align: center;
      padding: 20px;
    }

    #transcript {
      flex: 0 0 auto;
      max-height: 30vh;
      overflow-y: auto;
      background: rgba(0, 0, 0, 0.9);
      color: var(--text);
      font-size: 0.95rem;
      padding: 12px 16px;
      border-top: 1px solid var(--border);
      line-height: 1.4;
    }
    #user-line { color: #93c5fd; margin-bottom: 4px; }
    #ai-line { color: #6ee7b7; }
    .role-tag { opacity: 0.55; margin-right: 4px; }
  </style>
</head>
<body>
  <!-- ======== Start screen ======== -->
  <div id="start-screen">
    <svg width="128" height="128" viewBox="0 0 100 100" fill="none" aria-hidden="true">
      <rect x="8"  y="8"  width="28" height="28" rx="4" stroke="#10b981" stroke-width="3.5"/>
      <rect x="16" y="16" width="12" height="12" fill="#10b981" rx="1.5"/>
      <rect x="64" y="8"  width="28" height="28" rx="4" stroke="#10b981" stroke-width="3.5"/>
      <rect x="72" y="16" width="12" height="12" fill="#10b981" rx="1.5"/>
      <rect x="8"  y="64" width="28" height="28" rx="4" stroke="#10b981" stroke-width="3.5"/>
      <rect x="16" y="72" width="12" height="12" fill="#10b981" rx="1.5"/>
      <rect x="44" y="44" width="8" height="8" fill="#34d399" rx="1"/>
      <rect x="56" y="56" width="8" height="8" fill="#34d399" rx="1"/>
      <rect x="44" y="64" width="6" height="6" fill="#34d399" rx="1"/>
      <rect x="64" y="44" width="6" height="6" fill="#34d399" rx="1"/>
      <rect x="66" y="66" width="10" height="10" fill="#34d399" rx="1"/>
    </svg>
    <div class="brand">ShipMemory</div>
    <ol>
      <li>Press <strong>Start</strong> to begin the live stream from your glasses.</li>
      <li>Scan a <strong>QR code</strong> to start the live agent session.</li>
    </ol>
    <button id="start-btn">Start</button>
    <div id="start-status">Checking session…</div>
  </div>

  <!-- ======== Main screen ======== -->
  <div id="main-screen">
    <div id="toolbar">
      <div id="status-dot"></div>
      <div id="status-text">
        <div id="status-label">Starting…</div>
        <div id="status-detail"></div>
      </div>
      <div id="status-chip">IDLE</div>
    </div>

    <div id="action-bar">
      <button id="stop-session-btn" class="primary" style="display:none;">Stop session</button>
      <button id="rescan-btn" class="warn" style="display:none;">Retry scanning</button>
      <span id="action-empty" class="empty"></span>
    </div>

    <div id="viewer">
      <div id="iframe-player"><iframe id="preview-iframe" allow="autoplay"></iframe></div>
      <div id="viewer-placeholder">Waiting for camera stream…</div>
    </div>

    <div id="transcript">
      <div id="user-line"><span class="role-tag">You:</span><span id="user-text"></span></div>
      <div id="ai-line"><span class="role-tag">AI:</span><span id="ai-text"></span></div>
    </div>
  </div>

  <script>
    const startScreen = document.getElementById('start-screen');
    const startBtn = document.getElementById('start-btn');
    const startStatus = document.getElementById('start-status');

    const mainScreen = document.getElementById('main-screen');
    const statusDotEl = document.getElementById('status-dot');
    const statusLabelEl = document.getElementById('status-label');
    const statusDetailEl = document.getElementById('status-detail');
    const statusChipEl = document.getElementById('status-chip');

    const stopSessionBtn = document.getElementById('stop-session-btn');
    const rescanBtn = document.getElementById('rescan-btn');
    const actionEmptyEl = document.getElementById('action-empty');

    const iframePlayer = document.getElementById('iframe-player');
    const previewIframe = document.getElementById('preview-iframe');
    const viewerPlaceholder = document.getElementById('viewer-placeholder');

    const userTextEl = document.getElementById('user-text');
    const aiTextEl = document.getElementById('ai-text');
    const aiLineEl = document.getElementById('ai-line');

    let started = false;
    let startPressed = false;
    let streamAttached = false;
    let attachedIframeUrl = null;
    let thinking = false;

    function showStartScreen() {
      startScreen.style.display = 'flex';
      mainScreen.style.display = 'none';
    }
    function showMainScreen() {
      startScreen.style.display = 'none';
      mainScreen.style.display = 'flex';
    }

    // ---- Status resolver: (appState, scanStatus, streamStatus, sessionEndReason) → visual ----
    function resolveStatus(s) {
      // Priority order: stream errors > scan outcomes > app phases.
      if (s.appState === 'SESSION') {
        if (s.streamStatus === 'reconnecting') {
          return { label: 'Reconnecting stream', detail: 'Session held — voice continues', chip: 'SESSION', color: 'amber', pulsing: true };
        }
        if (s.streamStatus === 'error') {
          return { label: 'Stream lost', detail: 'Voice still working', chip: 'SESSION', color: 'red', pulsing: true };
        }
        return { label: 'In session', detail: 'Speak to Gemini', chip: 'SESSION', color: 'green', pulsing: true };
      }
      if (s.appState === 'SCANNING') {
        if (s.scanStatus === 'timeout') {
          return { label: 'Scan timed out', detail: 'Tap Retry scanning below', chip: 'SCAN', color: 'red', pulsing: false };
        }
        const detail = s.sessionEndReason
          ? 'Previous session: ' + s.sessionEndReason + ' — rescanning'
          : (s.scanStartedAt ? formatElapsed(s.scanStartedAt) + ' elapsed' : 'Point glasses at a QR code');
        return { label: 'Scanning for QR', detail, chip: 'SCAN', color: 'amber', pulsing: true };
      }
      // IDLE (during a brief transition)
      if (s.sessionEndReason) {
        return { label: 'Session ended', detail: s.sessionEndReason, chip: 'IDLE', color: 'neutral', pulsing: false };
      }
      return { label: 'Ready', detail: '', chip: 'IDLE', color: 'neutral', pulsing: false };
    }
    function formatElapsed(startedAt) {
      const s = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
      const mm = Math.floor(s / 60);
      const ss = (s % 60).toString().padStart(2, '0');
      return mm + ':' + ss;
    }
    const COLOR_MAP = {
      green:   { dot: '#10b981', chipBg: '#064e3b', chipFg: '#6ee7b7' },
      amber:   { dot: '#f59e0b', chipBg: '#78350f', chipFg: '#fde68a' },
      red:     { dot: '#ef4444', chipBg: '#7f1d1d', chipFg: '#fecaca' },
      neutral: { dot: '#6b7280', chipBg: '#1f2937', chipFg: '#9ca3af' },
    };
    function renderStatus(s) {
      const v = resolveStatus(s);
      const c = COLOR_MAP[v.color] || COLOR_MAP.neutral;
      statusDotEl.style.background = c.dot;
      statusDotEl.style.color = c.dot;
      statusDotEl.classList.toggle('pulsing', !!v.pulsing);
      statusLabelEl.textContent = v.label;
      statusDetailEl.textContent = v.detail;
      statusChipEl.textContent = v.chip;
      statusChipEl.style.background = c.chipBg;
      statusChipEl.style.color = c.chipFg;
    }

    // ---- Transcript ----
    let lastTranscriptRole = null;
    function clearThinking() {
      if (thinking) {
        thinking = false;
        aiTextEl.textContent = '';
        aiLineEl.style.opacity = '1';
        aiLineEl.style.fontStyle = 'normal';
      }
    }
    function onTranscriptEvent(ev) {
      if (ev.type === 'user') {
        if (lastTranscriptRole === 'ai') {
          userTextEl.textContent = '';
          aiTextEl.textContent = '';
        }
        clearThinking();
        userTextEl.textContent += ev.text;
        lastTranscriptRole = 'user';
      } else if (ev.type === 'thinking') {
        if (!thinking) {
          thinking = true;
          aiTextEl.textContent = 'thinking…';
          aiLineEl.style.opacity = '0.55';
          aiLineEl.style.fontStyle = 'italic';
        }
      } else if (ev.type === 'ai') {
        clearThinking();
        aiTextEl.textContent += ev.text;
        lastTranscriptRole = 'ai';
      }
    }
    try {
      const sse = new EventSource('/api/transcript/stream');
      sse.onmessage = (e) => { try { onTranscriptEvent(JSON.parse(e.data)); } catch {} };
    } catch (e) { console.warn('Transcript SSE unavailable:', e); }

    // ---- Gate polling (1s) ----
    async function pollGate() {
      try {
        const res = await fetch('/api/state');
        const s = await res.json();

        // Screen switching
        if (!s.hasSession) {
          showStartScreen();
          startBtn.style.display = 'none';
          startStatus.textContent = 'Waiting for glasses session — open the app on your glasses.';
        } else if (!s.started) {
          // Reset if we were previously in main
          if (started) {
            started = false;
            startPressed = false;
            startBtn.disabled = false;
            streamAttached = false;
            attachedIframeUrl = null;
            previewIframe.src = 'about:blank';
          }
          showStartScreen();
          startBtn.style.display = 'inline-block';
          startStatus.textContent = startPressed ? 'Starting…' : 'Ready to start.';
        } else {
          showMainScreen();
          if (!started) {
            started = true;
            startPressed = false;
          }
          renderStatus(s);

          // Action buttons
          stopSessionBtn.style.display = s.canStopSession ? 'inline-block' : 'none';
          rescanBtn.style.display = s.canRescan ? 'inline-block' : 'none';
          actionEmptyEl.textContent = (!s.canStopSession && !s.canRescan) ? 'No actions available' : '';
        }
      } catch (e) {
        startStatus.textContent = 'Connection error: ' + e;
      }
      setTimeout(pollGate, 1000);
    }

    // ---- Actions ----
    async function postAction(path, btn) {
      btn.disabled = true;
      try {
        const res = await fetch(path, { method: 'POST' });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          console.warn(path + ' failed:', body.error || res.status);
        }
      } catch (e) {
        console.warn(path + ' error:', e);
      } finally {
        setTimeout(() => { btn.disabled = false; }, 1500);
      }
    }
    stopSessionBtn.addEventListener('click', () => postAction('/api/stop-session', stopSessionBtn));
    rescanBtn.addEventListener('click', () => postAction('/api/rescan', rescanBtn));

    startBtn.addEventListener('click', async () => {
      if (startPressed) return;
      startPressed = true;
      startBtn.disabled = true;
      startStatus.textContent = 'Starting…';
      try {
        const res = await fetch('/api/start', { method: 'POST' });
        const body = await res.json();
        if (!res.ok) {
          startPressed = false;
          startBtn.disabled = false;
          startStatus.textContent = body.error || 'Start failed';
        }
      } catch (e) {
        startPressed = false;
        startBtn.disabled = false;
        startStatus.textContent = 'Start error: ' + e;
      }
    });

    pollGate();

    // ---- Cloudflare preview iframe polling (2s) ----
    async function pollStream() {
      try {
        const res = await fetch('/api/stream');
        const data = await res.json();
        if (data.status === 'active' && data.iframeUrl) {
          if (!streamAttached || data.iframeUrl !== attachedIframeUrl) {
            streamAttached = true;
            attachedIframeUrl = data.iframeUrl;
            viewerPlaceholder.style.display = 'none';
            iframePlayer.style.display = 'block';
            previewIframe.src = data.iframeUrl;
          }
        } else if (data.status === 'reconnecting' || data.status === 'error') {
          if (streamAttached) {
            streamAttached = false;
            attachedIframeUrl = null;
            iframePlayer.style.display = 'none';
            previewIframe.src = 'about:blank';
            viewerPlaceholder.style.display = 'flex';
            viewerPlaceholder.textContent = data.status === 'reconnecting' ? 'Reconnecting stream…' : 'Stream unavailable';
          }
        } else if (data.status === 'idle' || data.status === 'starting') {
          viewerPlaceholder.style.display = 'flex';
          viewerPlaceholder.textContent = 'Waiting for camera stream…';
        }
      } catch (e) { /* quiet */ }
      setTimeout(pollStream, 2000);
    }
    pollStream();
  </script>
</body>
</html>`;

const app = new ShipMemoryApp();
await app.start();

// v3 AppServer.start() only initializes — it does NOT bind an HTTP listener.
// We must run a Bun.serve() that delegates to app.fetch (Hono).
Bun.serve({
  port: env.PORT,
  idleTimeout: 120, // keep SSE connections alive
  fetch: (req) => app.fetch(req),
});

console.log(`[ShipMemory] Mentra client listening on port ${env.PORT}`);
