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

class ShipMemoryApp extends AppServer {
  private orchestrators = new Map<string, SessionOrchestrator>();

  constructor() {
    super({
      packageName: env.PACKAGE_NAME,
      apiKey: env.MENTRAOS_API_KEY,
      port: env.PORT,
    });
    this.setupWebviewRoutes();
    this.installSessionRequestDedupe();
  }

  /**
   * Dedupe Mentra session_request webhooks for the same sessionId.
   *
   * The SDK's default `handleSessionRequest` unconditionally tears down any
   * existing session (OWNERSHIP_RELEASE + disconnect) and creates a new one
   * whenever a session_request arrives — even if the webhook is a duplicate
   * (same sessionId, same WS URL) from a phone foreground, Wi-Fi handoff,
   * etc. That churn kills the stream mid-flight and produces audible
   * start/stop cycles on the glasses.
   *
   * This wrapper intercepts the call. If we already have a session for this
   * sessionId AND the webhook is pointing at the same WS URL, we ACK 200
   * and skip the teardown — the live session keeps running. If the URL
   * actually changed, we fall through to the SDK's original behavior.
   *
   * `handleSessionRequest` is typed `private` in the SDK, but it's a normal
   * method at runtime and `setupWebhook` invokes it via `this.` — so
   * replacing it on the instance works.
   */
  private installSessionRequestDedupe(): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const self = this as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const original = (self.handleSessionRequest as (req: any, res: any) => Promise<void>).bind(self);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    self.handleSessionRequest = async (request: any, res: any): Promise<void> => {
      const sessionId: string | undefined = request?.sessionId;
      const newUrl: string | undefined = request?.mentraOSWebsocketUrl ?? request?.augmentOSWebsocketUrl;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const activeSessions: Map<string, any> = self.activeSessions;
      const existing = sessionId ? activeSessions.get(sessionId) : undefined;

      if (existing) {
        const existingUrl: string | undefined = existing?.config?.mentraOSWebsocketUrl;
        if (existingUrl && newUrl && existingUrl === newUrl) {
          console.log(`[ShipMemory] Dedupe: ignoring duplicate session_request for ${sessionId} (same WS URL, existing session alive)`);
          res.status(200).json({ status: 'success' });
          return;
        }
        console.log(
          `[ShipMemory] Session URL changed for ${sessionId} (existing=${existingUrl}, new=${newUrl}) — allowing SDK reconnect`,
        );
      }

      return original(request, res);
    };
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

    session.layouts.showTextWall('ShipMemory starting…');

    const orchestrator = new SessionOrchestrator(session, sessionId, env);
    this.orchestrators.set(sessionId, orchestrator);

    // Identity-match guard: onDisconnected can fire LATE for an old session
    // whose sessionId was already reused by a new orchestrator (Mentra
    // switching_clouds). Without this check, the old session's disconnect
    // destroys the new orchestrator mid-init.
    session.events.onDisconnected((data) => {
      if (this.orchestrators.get(sessionId) !== orchestrator) {
        console.log(`[ShipMemory] Ignoring stale onDisconnected for ${sessionId} — orchestrator replaced`);
        return;
      }
      console.log(`[ShipMemory] Session WebSocket disconnected: ${sessionId}`, data);
      this.cleanupSession(sessionId, 'onDisconnected');
    });
    // onError is observational only. The SDK fires it for every internal
    // WebSocket send failure after a drop, so using it to trigger cleanup
    // causes a flood of redundant destroy calls. Lifecycle is handled by
    // onStop + onDisconnected.
    session.events.onError((err) => {
      console.error(`[ShipMemory] Session error: ${sessionId}`, err instanceof Error ? err.message : err);
    });

    await orchestrator.start();
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

  private cleanupSession(sessionId: string, trigger: string): void {
    const orchestrator = this.orchestrators.get(sessionId);
    if (orchestrator) {
      orchestrator.destroy(trigger);
      this.orchestrators.delete(sessionId);
    }
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
    #player {
      display: none;
      width: 100%;
      height: 100%;
    }
    video {
      width: 100%;
      height: 100%;
      object-fit: contain;
      background: #000;
    }
  </style>
</head>
<body>
  <div id="status">
    <p>Starting up livestream<span class="dot"> ...</span></p>
  </div>
  <div id="player">
    <video id="video" autoplay muted playsinline></video>
  </div>
  <div id="iframe-player" style="display:none; width:100%; height:100%;">
    <iframe id="preview-iframe" style="width:100%; height:100%; border:none;" allow="autoplay"></iframe>
  </div>
  <pre id="log" style="position:fixed; bottom:0; left:0; right:0; max-height:30vh; overflow-y:auto; background:rgba(0,0,0,0.85); color:#0f0; font-size:0.75rem; padding:8px; z-index:100;"></pre>

  <script>
    const statusEl = document.getElementById('status');
    const playerEl = document.getElementById('player');
    const videoEl = document.getElementById('video');
    const iframePlayer = document.getElementById('iframe-player');
    const previewIframe = document.getElementById('preview-iframe');
    const logEl = document.getElementById('log');
    let started = false;

    function log(msg) {
      console.log(msg);
      logEl.textContent += msg + '\\n';
      logEl.scrollTop = logEl.scrollHeight;
    }

    async function poll() {
      try {
        const res = await fetch('/api/stream');
        const data = await res.json();
        log('Poll: status=' + data.status + ' webrtc=' + !!data.webrtcUrl + ' iframe=' + !!data.iframeUrl);

        if (data.status === 'active' && !started) {
          started = true;

          // Try WebRTC WHEP first (low latency, we can extract frames)
          // Fall back to Cloudflare iframe preview
          if (data.webrtcUrl) {
            const ok = await tryWebRTC(data.webrtcUrl);
            if (ok) return;
          }
          if (data.iframeUrl) {
            log('Falling back to iframe preview');
            statusEl.style.display = 'none';
            iframePlayer.style.display = 'block';
            previewIframe.src = data.iframeUrl;
            return;
          }
          statusEl.innerHTML = '<p>No playable stream URL</p>';
        }
      } catch (e) { log('Poll error: ' + e); }

      if (!started) setTimeout(poll, 2000);
    }

    async function tryWebRTC(whepUrl) {
      statusEl.innerHTML = '<p>Connecting via WebRTC<span class="dot"> ...</span></p>';
      try {
        const pc = new RTCPeerConnection();
        pc.addTransceiver('video', { direction: 'recvonly' });
        pc.addTransceiver('audio', { direction: 'recvonly' });

        pc.oniceconnectionstatechange = () => log('ICE: ' + pc.iceConnectionState);
        pc.onconnectionstatechange = () => log('Conn: ' + pc.connectionState);

        pc.ontrack = (e) => {
          log('Track: ' + e.track.kind + ' streams=' + e.streams.length);
          if (e.streams[0]) {
            videoEl.srcObject = e.streams[0];
            statusEl.style.display = 'none';
            playerEl.style.display = 'block';
            videoEl.play().catch(e => log('Play error: ' + e));
          }
        };

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        log('WHEP POST → ' + whepUrl.slice(0, 80));

        const res = await fetch(whepUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/sdp' },
          body: offer.sdp,
        });

        log('WHEP response: ' + res.status + ' ' + res.statusText);

        if (!res.ok) {
          const body = await res.text();
          log('WHEP error: ' + body.slice(0, 300));
          throw new Error('WHEP ' + res.status);
        }

        const answer = await res.text();
        log('SDP answer: ' + answer.length + ' bytes');
        await pc.setRemoteDescription({ type: 'answer', sdp: answer });
        log('Remote description set — waiting for tracks');
        return true;
      } catch (err) {
        log('WebRTC failed: ' + err);
        return false;
      }
    }

    poll();
  </script>
</body>
</html>`;

const app = new ShipMemoryApp();
app.start().catch(console.error);
console.log(`[ShipMemory] Mentra client listening on port ${env.PORT}`);
