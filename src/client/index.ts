import { AppServer, AppSession } from '@mentra/sdk';
import { streamSSE } from 'hono/streaming';
import { EventEmitter } from 'node:events';
import { env } from './config/env.js';
import { SessionOrchestrator } from './app/session.js';

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
      const canStartOver = started && (!!streamState.sessionEndReason || appState !== 'IDLE');
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
        canStartOver,
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

    // User-initiated stop: tears the orchestrator down and recreates a
    // fresh one so the Start button reappears in the webview.
    this.post('/api/stop', (c) => {
      const sessionId = this.orchestrators.keys().next().value ?? null;
      if (!sessionId) return c.json({ error: 'No active session' }, 404);
      console.log(`[ShipMemory] User triggered stop for ${sessionId}`);
      // Trigger the orchestrator's onEnded path so a fresh orchestrator is
      // stood up automatically (same flow as Gemini disconnect).
      const orchestrator = this.orchestrators.get(sessionId);
      if (orchestrator?.onEnded) {
        streamState.sessionEndReason = 'user_stop';
        orchestrator.onEnded('user_stop');
      } else {
        this.cleanupSession(sessionId, 'user_stop');
      }
      return c.json({ status: 'stopped', sessionId });
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

    console.log('[ShipMemory] Routes: /webview (stream), /frame (camera preview), /api/frame (raw JPEG)');
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

    // When Gemini disconnects the orchestrator flips itself to IDLE; we
    // tear it down and stand up a fresh one so the webview's next poll
    // sees started=false and can offer a new Start button without the
    // user having to relaunch the app. Factory recreates itself after
    // each end so repeated restart cycles all wire onEnded correctly.
    const makeOrchestrator = (): SessionOrchestrator => {
      const o = new SessionOrchestrator(session, sessionId, env);
      o.onEnded = (reason) => {
        if (this.orchestrators.get(sessionId) !== o) return;
        console.log(`[ShipMemory] Session ${sessionId} ended (${reason}) — recreating orchestrator`);
        this.cleanupSession(sessionId, `session_ended:${reason}`);
        streamState.sessionEndReason = reason;
        this.orchestrators.set(sessionId, makeOrchestrator());
      };
      return o;
    };
    const orchestrator = makeOrchestrator();
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
  <title>ShipMemory — Live View</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #0a0a0a;
      color: #fff;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
    }
    #status {
      text-align: center;
      font-size: 1.4rem;
      color: #888;
      transition: opacity 0.4s;
    }
    #status .dot {
      display: inline-block;
      animation: pulse 1.5s infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 0.3; }
      50% { opacity: 1; }
    }
  </style>
</head>
<body>
  <div id="mode-badge" style="position:fixed; top:12px; left:50%; transform:translateX(-50%); z-index:50; padding:6px 12px; border-radius:999px; font-size:0.8rem; font-weight:600; background:#1f2937; color:#9ca3af; letter-spacing:0.05em;">Idle</div>
  <div id="reconnect-banner" style="display:none; position:fixed; top:52px; left:50%; transform:translateX(-50%); z-index:49; padding:8px 18px; border-radius:10px; font-size:0.85rem; font-weight:600; background:#7c2d12; color:#fed7aa; letter-spacing:0.02em; box-shadow:0 4px 12px rgba(0,0,0,0.3);">Reconnecting stream…</div>
  <div id="ended-banner" style="display:none; position:fixed; top:52px; left:50%; transform:translateX(-50%); z-index:48; padding:8px 18px; border-radius:10px; font-size:0.85rem; font-weight:600; background:#1e3a8a; color:#dbeafe; letter-spacing:0.02em; box-shadow:0 4px 12px rgba(0,0,0,0.3);"></div>

  <div id="action-bar" style="display:none; position:fixed; top:96px; left:50%; transform:translateX(-50%); z-index:47; display:flex; gap:8px; flex-wrap:wrap; justify-content:center; max-width:90vw;">
    <button id="rescan-btn" style="display:none; padding:10px 18px; font-size:0.9rem; background:#d97706; color:#fff; border:none; border-radius:10px; cursor:pointer; font-weight:600;">Scan again</button>
    <button id="restart-stream-btn" style="display:none; padding:10px 18px; font-size:0.9rem; background:#7c2d12; color:#fed7aa; border:none; border-radius:10px; cursor:pointer; font-weight:600;">Restart stream</button>
    <button id="stop-btn" style="display:none; padding:10px 18px; font-size:0.9rem; background:#374151; color:#e5e7eb; border:none; border-radius:10px; cursor:pointer; font-weight:600;">Start new session</button>
  </div>

  <div id="gate" style="display:flex; flex-direction:column; align-items:center; gap:16px; max-width:420px; padding:0 20px;">
    <div id="gate-header" style="display:none; font-size:1.4rem; color:#e5e7eb; text-align:center; font-weight:600;">ShipMemory</div>
    <div id="gate-subheader" style="display:none; font-size:1rem; color:#9ca3af; text-align:center;">Scan a QR to start a voice session.</div>
    <div id="gate-status" style="font-size:1.1rem; color:#888; text-align:center;">Checking session…</div>
    <button id="start-btn" style="display:none; padding:18px 48px; font-size:1.3rem; background:#10b981; color:#fff; border:none; border-radius:12px; cursor:pointer; font-weight:600; transition:opacity 0.2s;">Start</button>
    <style>
      #start-btn:disabled { opacity:0.4; cursor:not-allowed; }
      #rescan-btn:disabled, #restart-stream-btn:disabled, #stop-btn:disabled { opacity:0.5; cursor:not-allowed; }
    </style>
    <div id="gate-hint" style="display:none; font-size:0.85rem; color:#666; text-align:center; line-height:1.45;">
      Tap Start — camera opens, scans for a QR for up to 2 min, then Gemini Live takes over for voice. If the scan times out, use "Scan again" below.
    </div>
  </div>

  <div id="status" style="display:none;">
    <p>Starting up livestream<span class="dot"> ...</span></p>
  </div>
  <div id="iframe-player" style="display:none; width:100%; height:100%;">
    <iframe id="preview-iframe" style="width:100%; height:100%; border:none;" allow="autoplay"></iframe>
  </div>
  <div id="transcript" style="position:fixed; bottom:0; left:0; right:0; min-height:72px; max-height:30vh; overflow-y:auto; background:rgba(0,0,0,0.85); color:#e5e7eb; font-size:0.95rem; padding:12px 16px; z-index:40; border-top:1px solid #1f2937; line-height:1.4;">
    <div id="user-line" style="color:#93c5fd; margin-bottom:4px;"><span style="opacity:0.6">You:</span> <span id="user-text"></span></div>
    <div id="ai-line" style="color:#6ee7b7;"><span style="opacity:0.6">AI:</span> <span id="ai-text"></span></div>
  </div>

  <script>
    const gateEl = document.getElementById('gate');
    const gateHeaderEl = document.getElementById('gate-header');
    const gateSubheaderEl = document.getElementById('gate-subheader');
    const gateStatusEl = document.getElementById('gate-status');
    const startBtn = document.getElementById('start-btn');
    const gateHintEl = document.getElementById('gate-hint');
    const statusEl = document.getElementById('status');
    const iframePlayer = document.getElementById('iframe-player');
    const previewIframe = document.getElementById('preview-iframe');
    const modeBadgeEl = document.getElementById('mode-badge');
    const reconnectBannerEl = document.getElementById('reconnect-banner');
    const endedBannerEl = document.getElementById('ended-banner');
    const actionBarEl = document.getElementById('action-bar');
    const rescanBtn = document.getElementById('rescan-btn');
    const restartStreamBtn = document.getElementById('restart-stream-btn');
    const stopBtn = document.getElementById('stop-btn');
    const userTextEl = document.getElementById('user-text');
    const aiTextEl = document.getElementById('ai-text');
    const userLineEl = document.getElementById('user-line');
    const aiLineEl = document.getElementById('ai-line');
    let started = false;
    let streamAttached = false;
    let startPressed = false;
    let attachedIframeUrl = null;
    let thinking = false;

    const MODE_STYLES = {
      IDLE:     { label: 'Idle',     bg: '#1f2937', fg: '#9ca3af' },
      SCANNING: { label: 'Scanning', bg: '#78350f', fg: '#fde68a' },
      SESSION:  { label: 'Session',  bg: '#064e3b', fg: '#6ee7b7' },
    };
    function renderMode(state) {
      const s = MODE_STYLES[state] || MODE_STYLES.IDLE;
      modeBadgeEl.textContent = s.label;
      modeBadgeEl.style.background = s.bg;
      modeBadgeEl.style.color = s.fg;
    }

    // --- Transcript stream: show current turn (You + AI) ---
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
          // New user turn after an AI reply — clear both lines.
          userTextEl.textContent = '';
          aiTextEl.textContent = '';
        }
        clearThinking();
        userTextEl.textContent += ev.text;
        lastTranscriptRole = 'user';
      } else if (ev.type === 'thinking') {
        // User just finished speaking — show a dim placeholder until Gemini
        // starts streaming its reply. Cleared by the next 'ai' chunk.
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
      // turn_complete: keep the AI reply on screen until the next user turn.
    }
    try {
      const sse = new EventSource('/api/transcript/stream');
      sse.onmessage = (e) => {
        try { onTranscriptEvent(JSON.parse(e.data)); } catch {}
      };
      // EventSource auto-reconnects on error; nothing to do.
    } catch (e) {
      console.warn('Transcript SSE unavailable:', e);
    }

    async function pollGate() {
      try {
        const res = await fetch('/api/state');
        const s = await res.json();
        renderMode(s.appState);

        // --- Recovery buttons ---
        rescanBtn.style.display = s.canRescan ? 'inline-block' : 'none';
        restartStreamBtn.style.display = s.canRestartStream ? 'inline-block' : 'none';
        stopBtn.style.display = s.canStartOver ? 'inline-block' : 'none';
        const anyAction = s.canRescan || s.canRestartStream || s.canStartOver;
        actionBarEl.style.display = anyAction ? 'flex' : 'none';

        // --- Stream status banner ---
        if (s.streamStatus === 'error') {
          reconnectBannerEl.style.display = 'block';
          reconnectBannerEl.textContent = 'Stream failed — tap Restart stream below';
          reconnectBannerEl.style.background = '#7f1d1d';
          reconnectBannerEl.style.color = '#fecaca';
        } else if (s.streamStatus === 'reconnecting') {
          reconnectBannerEl.style.display = 'block';
          reconnectBannerEl.textContent = 'Reconnecting stream…';
          reconnectBannerEl.style.background = '#7c2d12';
          reconnectBannerEl.style.color = '#fed7aa';
        } else {
          reconnectBannerEl.style.display = 'none';
        }

        // --- Scan timeout hint ---
        if (s.appState === 'SCANNING' && s.scanStatus === 'timeout') {
          reconnectBannerEl.style.display = 'block';
          reconnectBannerEl.textContent = 'Scan timed out — tap Scan again below';
          reconnectBannerEl.style.background = '#78350f';
          reconnectBannerEl.style.color = '#fde68a';
        }

        // --- Session-ended banner ---
        if (s.sessionEndReason && !s.started) {
          endedBannerEl.style.display = 'block';
          endedBannerEl.textContent = 'Previous session ended: ' + s.sessionEndReason;
        } else {
          endedBannerEl.style.display = 'none';
        }

        if (!s.hasSession) {
          gateHeaderEl.style.display = 'none';
          gateSubheaderEl.style.display = 'none';
          gateStatusEl.textContent = 'Waiting for glasses session — open the app on your glasses.';
          startBtn.style.display = 'none';
          gateHintEl.style.display = 'none';
        } else if (!s.started) {
          // Orchestrator may have been recreated (server flipped started → false).
          // Reset our local flags so the Start button becomes live again.
          if (started) {
            started = false;
            streamAttached = false;
            attachedIframeUrl = null;
            startPressed = false;
            startBtn.disabled = false;
            iframePlayer.style.display = 'none';
            previewIframe.src = 'about:blank';
            statusEl.style.display = 'none';
            gateEl.style.display = 'flex';
          }
          gateHeaderEl.style.display = 'block';
          gateSubheaderEl.style.display = 'block';
          if (startPressed) {
            gateStatusEl.textContent = 'Starting…';
          } else {
            gateStatusEl.textContent = s.sessionEndReason ? 'Tap Start to begin a new session.' : 'Ready to start.';
            startBtn.style.display = 'inline-block';
            gateHintEl.style.display = 'block';
          }
        } else {
          // User tapped Start — hide the gate, show the player flow.
          // Keep pollGate running so the mode badge keeps updating as the
          // orchestrator transitions SCANNING → SESSION.
          gateEl.style.display = 'none';
          if (!started) {
            started = true;
            statusEl.style.display = 'block';
            poll();
          }
        }
      } catch (e) {
        gateStatusEl.textContent = 'Connection error: ' + e;
      }
      setTimeout(pollGate, 1000);
    }

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
        // Re-enable shortly; pollGate will hide the button if no longer valid.
        setTimeout(() => { btn.disabled = false; }, 1500);
      }
    }
    rescanBtn.addEventListener('click', () => postAction('/api/rescan', rescanBtn));
    restartStreamBtn.addEventListener('click', () => postAction('/api/restart-stream', restartStreamBtn));
    stopBtn.addEventListener('click', () => postAction('/api/stop', stopBtn));

    startBtn.addEventListener('click', async () => {
      if (startPressed) return;
      startPressed = true;
      startBtn.disabled = true;
      gateStatusEl.textContent = 'Starting…';
      try {
        const res = await fetch('/api/start', { method: 'POST' });
        const body = await res.json();
        console.log('Start response:', body);
        if (!res.ok) {
          startPressed = false;
          startBtn.disabled = false;
          gateStatusEl.textContent = body.error || 'Start failed';
        }
      } catch (e) {
        startPressed = false;
        startBtn.disabled = false;
        gateStatusEl.textContent = 'Start error: ' + e;
      }
    });

    pollGate();

    async function poll() {
      try {
        const res = await fetch('/api/stream');
        const data = await res.json();
        console.log('Poll: status=' + data.status + ' iframe=' + !!data.iframeUrl);

        if (data.status === 'active' && data.iframeUrl) {
          if (!streamAttached || data.iframeUrl !== attachedIframeUrl) {
            streamAttached = true;
            attachedIframeUrl = data.iframeUrl;
            console.log('Attaching Cloudflare preview iframe');
            statusEl.style.display = 'none';
            iframePlayer.style.display = 'block';
            previewIframe.src = data.iframeUrl;
          }
        } else if (data.status === 'reconnecting') {
          // Preview iframe from the old stream is dead. Clear it and show the
          // spinner until a new iframeUrl arrives.
          if (streamAttached) {
            streamAttached = false;
            attachedIframeUrl = null;
            iframePlayer.style.display = 'none';
            previewIframe.src = 'about:blank';
            statusEl.style.display = 'block';
          }
        }
      } catch (e) { console.warn('Poll error:', e); }

      setTimeout(poll, 2000);
    }
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
