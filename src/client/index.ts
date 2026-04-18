import { AppServer, AppSession } from '@mentra/sdk';
import { env } from './config/env.js';
import { SessionOrchestrator } from './app/session.js';

/** Shared stream state so the /webview route can access current URLs */
export const streamState: {
  hlsUrl: string | null;
  webrtcUrl: string | null;
  previewUrl: string | null;
  dashUrl: string | null;
  status: 'idle' | 'starting' | 'active';
  latestJpeg: Buffer | null;
  latestJpegTime: number;
  frameCount: number;
} = { hlsUrl: null, webrtcUrl: null, previewUrl: null, dashUrl: null, status: 'idle', latestJpeg: null, latestJpegTime: 0, frameCount: 0 };

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
    const express = this.getExpressApp();

    // Stream status API (polled by the webview page)
    express.get('/api/stream', (_req, res) => {
      res.json({
        hlsUrl: streamState.hlsUrl,
        webrtcUrl: streamState.webrtcUrl,
        previewUrl: streamState.previewUrl,
        dashUrl: streamState.dashUrl,
        status: streamState.status,
        frameCount: streamState.frameCount,
        iframeUrl: streamState.previewUrl,
      });
    });

    // Session state for the webview — lets the UI show a Start button
    // until the user explicitly triggers orchestrator.start().
    express.get('/api/state', (_req, res) => {
      const sessionId = this.orchestrators.keys().next().value ?? null;
      const orchestrator = sessionId ? this.orchestrators.get(sessionId) : null;
      res.json({
        sessionId,
        hasSession: !!sessionId,
        started: sessionId ? this.startedSessions.has(sessionId) : false,
        streamStatus: streamState.status,
        appState: orchestrator ? orchestrator.getState() : 'IDLE',
      });
    });

    // Manual start trigger. Until the user POSTs here, the orchestrator
    // exists but hasn't touched camera / stream / WHEP. This lets the
    // user wait out any switching_clouds churn before committing
    // resources.
    express.post('/api/start', (_req, res) => {
      const sessionId = this.orchestrators.keys().next().value ?? null;
      if (!sessionId) {
        res.status(404).json({ error: 'No active session. Open the app on your glasses first.' });
        return;
      }
      if (this.startedSessions.has(sessionId)) {
        res.json({ status: 'already-started', sessionId });
        return;
      }
      const orchestrator = this.orchestrators.get(sessionId);
      if (!orchestrator) {
        res.status(404).json({ error: 'Orchestrator missing for session' });
        return;
      }
      this.startedSessions.add(sessionId);
      console.log(`[ShipMemory] User triggered start via webview for ${sessionId}`);
      res.json({ status: 'starting', sessionId });
      // Fire-and-forget. Errors get caught and run cleanupSession.
      orchestrator.start().catch((err) => {
        console.error(`[ShipMemory] orchestrator.start() failed for ${sessionId} — cleaning up`, err);
        this.cleanupSession(sessionId, 'start-failed');
      });
    });

    // Latest camera frame as JPEG (for debugging)
    express.get('/api/frame', (_req, res) => {
      if (!streamState.latestJpeg) {
        res.status(404).send('No frame available yet');
        return;
      }
      res.set('Content-Type', 'image/jpeg');
      res.set('Cache-Control', 'no-cache, no-store');
      res.send(streamState.latestJpeg);
    });

    // Live frame preview page (auto-refreshes)
    express.get('/frame', (_req, res) => {
      res.type('html').send(FRAME_PREVIEW_HTML);
    });

    // Webview page
    express.get('/webview', (_req, res) => {
      res.type('html').send(WEBVIEW_HTML);
    });

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

    session.layouts.showTextWall('Open the webview and tap Start');

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
  <div id="mode-badge" style="position:fixed; top:12px; right:12px; z-index:50; padding:6px 12px; border-radius:999px; font-size:0.8rem; font-weight:600; background:#1f2937; color:#9ca3af; letter-spacing:0.05em;">Idle</div>

  <div id="gate" style="display:flex; flex-direction:column; align-items:center; gap:20px;">
    <div id="gate-status" style="font-size:1.1rem; color:#888; text-align:center;">Checking session…</div>
    <button id="start-btn" style="display:none; padding:18px 48px; font-size:1.3rem; background:#10b981; color:#fff; border:none; border-radius:12px; cursor:pointer; font-weight:600; transition:opacity 0.2s;">Start</button>
    <style>
      #start-btn:disabled { opacity:0.4; cursor:not-allowed; }
    </style>
    <div id="gate-hint" style="display:none; font-size:0.9rem; color:#666; text-align:center; max-width:340px; line-height:1.45;">
      Tap Start to begin. The camera starts, looks for a QR code for up to 2 minutes, then Gemini Live takes over for voice. The camera stays off until you tap.
    </div>
  </div>

  <div id="status" style="display:none;">
    <p>Starting up livestream<span class="dot"> ...</span></p>
  </div>
  <div id="iframe-player" style="display:none; width:100%; height:100%;">
    <iframe id="preview-iframe" style="width:100%; height:100%; border:none;" allow="autoplay"></iframe>
  </div>
  <pre id="log" style="position:fixed; bottom:0; left:0; right:0; max-height:30vh; overflow-y:auto; background:rgba(0,0,0,0.85); color:#0f0; font-size:0.75rem; padding:8px; z-index:100;"></pre>

  <script>
    const gateEl = document.getElementById('gate');
    const gateStatusEl = document.getElementById('gate-status');
    const startBtn = document.getElementById('start-btn');
    const gateHintEl = document.getElementById('gate-hint');
    const statusEl = document.getElementById('status');
    const iframePlayer = document.getElementById('iframe-player');
    const previewIframe = document.getElementById('preview-iframe');
    const logEl = document.getElementById('log');
    const modeBadgeEl = document.getElementById('mode-badge');
    let started = false;
    let streamAttached = false;
    let startPressed = false;

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

    function log(msg) {
      console.log(msg);
      logEl.textContent += msg + '\\n';
      logEl.scrollTop = logEl.scrollHeight;
    }

    async function pollGate() {
      try {
        const res = await fetch('/api/state');
        const s = await res.json();
        renderMode(s.appState);
        if (!s.hasSession) {
          gateStatusEl.textContent = 'Waiting for glasses session — open the app on your glasses.';
          startBtn.style.display = 'none';
          gateHintEl.style.display = 'none';
        } else if (!s.started) {
          if (startPressed) {
            gateStatusEl.textContent = 'Starting…';
          } else {
            gateStatusEl.textContent = 'Ready to start.';
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

    startBtn.addEventListener('click', async () => {
      if (startPressed) return;
      startPressed = true;
      startBtn.disabled = true;
      gateStatusEl.textContent = 'Starting…';
      try {
        const res = await fetch('/api/start', { method: 'POST' });
        const body = await res.json();
        log('Start response: ' + JSON.stringify(body));
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
        log('Poll: status=' + data.status + ' iframe=' + !!data.iframeUrl);

        if (data.status === 'active' && !streamAttached) {
          if (data.iframeUrl) {
            streamAttached = true;
            log('Attaching Cloudflare preview iframe');
            statusEl.style.display = 'none';
            iframePlayer.style.display = 'block';
            previewIframe.src = data.iframeUrl;
            return;
          }
          // Active but no preview URL yet — keep polling, do not latch.
          log('Stream active but no iframeUrl yet — waiting');
        }
      } catch (e) { log('Poll error: ' + e); }

      if (!streamAttached) setTimeout(poll, 2000);
    }
  </script>
</body>
</html>`;

const app = new ShipMemoryApp();
app.start().catch(console.error);
console.log(`[ShipMemory] Mentra client listening on port ${env.PORT}`);
