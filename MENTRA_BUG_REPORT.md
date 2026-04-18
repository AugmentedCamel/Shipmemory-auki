# MentraOS SDK Bug Report — Session webhook churn

**SDK version:** `@mentra/sdk@2.1.29`
**Platform:** Node.js server on Railway, iPhone + Mentra Live glasses
**Date observed:** 2026-04-17

## Summary

The SDK unconditionally tears down and recreates a session on every `session_request` webhook, even when the webhook is a **duplicate** (same `sessionId` and same `mentraOSWebsocketUrl`). In practice, our server receives these duplicates every 10–70 seconds during normal use, producing audible glasses-side stream start/stop cycles, stranded Cloudflare streams, and 30-second stall periods on the next managed-stream allocation.

## Root cause

In `node_modules/@mentra/sdk/dist/index.js` (handleSessionRequest, ≈ line 5209):

```js
async handleSessionRequest(request, res) {
  const { sessionId, userId, mentraOSWebsocketUrl } = request;
  const existingSession = this.activeSessions.get(sessionId);
  if (existingSession) {
    await existingSession.releaseOwnership("switching_clouds");
    existingSession.disconnect();
    this.activeSessions.delete(sessionId);
    // ...
  }
  // always create a new AppSession regardless of whether the webhook was a duplicate
  const session = new AppSession({ ..., mentraOSWebsocketUrl, ... });
}
```

No check that the webhook represents an actual cloud change versus a duplicate from the same cloud.

## Observed behaviour

Six `session_request` webhooks for the same `sessionId` within ~2 minutes, all pointing at `wss://franceapi.mentra.glass/app-ws`:

```
13:57:51  Received session request
13:58:02  🔄 Existing session found ... sending OWNERSHIP_RELEASE
13:59:12  🔄 Existing session found ... sending OWNERSHIP_RELEASE
13:59:23  🔄 Existing session found ... sending OWNERSHIP_RELEASE
14:00:00  🔄 Existing session found ... sending OWNERSHIP_RELEASE
14:00:11  🔄 Existing session found ... sending OWNERSHIP_RELEASE
```

Every one of these killed the live managed stream and Gemini Live session. The user hears the glasses restart streaming each time.

## Downstream effects

1. **Audible stream cycle on glasses** — every teardown stops the managed camera stream and the next start plays the glasses' start tone.
2. **Cloudflare ghost streams** — `stopManagedStream` fails because the WebSocket has already been closed by the teardown (`WebSocket not connected (state: CLOSED)`), leaving the Cloudflare stream orphaned. The next `startManagedStream` times out after 30 seconds because Mentra cloud still sees the old allocation.
3. **Race with onDisconnected** — the old session's `onDisconnected` fires AFTER the new `AppSession` is already in `this.activeSessions` under the same key. Any app code that looks up by `sessionId` from its own map will destroy the new session by mistake.

## Evidence

Each churn cycle in our Railway logs:

```
[ShipMemory] New session: <id>        ← new AppSession added
[Session] Starting orchestrator       ← our code begins init
[Session] error ... Cannot process request - smart glasses must be connected to WiFi
[Session WebSocket disconnected]      ← OLD session's late-firing event
[Session WebSocket disconnected]
[Session] Destroying orchestrator     ← looks up by sessionId, destroys NEW
```

## Suggested SDK fix

Short-circuit when the incoming webhook URL matches the existing session's URL:

```js
async handleSessionRequest(request, res) {
  const { sessionId, mentraOSWebsocketUrl, augmentOSWebsocketUrl } = request;
  const newUrl = mentraOSWebsocketUrl || augmentOSWebsocketUrl;
  const existing = this.activeSessions.get(sessionId);
  if (existing && existing.config.mentraOSWebsocketUrl === newUrl) {
    this.logger.info({ sessionId }, `Duplicate session_request — existing session still live, ACK 200`);
    return res.status(200).json({ status: 'success' });
  }
  // ...existing teardown + recreate path unchanged
}
```

With this, the SDK only tears down when the cloud URL actually changed (legitimate `switching_clouds`), and ignores duplicates.

## Also worth investigating

Why is Mentra cloud sending these duplicate `session_request` webhooks in the first place? Our server isn't triggering them. They seem to fire on phone foreground, Wi-Fi transitions, and sometimes with no apparent cause. The SDK fix above makes us resilient to them, but the duplicates themselves look like a phone-side or cloud-side bug worth tracing separately.

## Workarounds we deployed in our app

Because we couldn't wait, we shipped these client-side workarounds:

| Commit | Change |
|---|---|
| `4af76d9` | Monkey-patch `handleSessionRequest` to dedupe same-URL webhooks (the fix above, applied locally) |
| `87fb5c3` | Identity-check in `onDisconnected` to stop old session's late events from destroying the new orchestrator |
| `f382894` | Retry `startManagedStream` once after a 30s timeout — calls `checkExistingStream` + `stopManagedStream` to clear the Cloudflare ghost |
| `24763d5` | Wait for managed stream `status === 'active'` before returning URLs, per [streaming docs](https://docs.mentraglass.com/app-devs/core-concepts/camera/streaming.md) |

## Environment

- Repo: https://github.com/AugmentedCamel/Shipmemory-auki (branch `main`)
- Relevant file: `src/client/index.ts` (monkey-patch at `installSessionRequestDedupe`)
- Deploy: Railway, France region
- Mentra cloud WS observed: `wss://franceapi.mentra.glass/app-ws`
- Glasses: Mentra Live
- iPhone, Mentra iOS app (version at time of report — please let me know if you need me to check)
