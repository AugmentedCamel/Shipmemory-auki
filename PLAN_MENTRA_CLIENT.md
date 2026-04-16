# Mentra Live Client — Implementation Plan

## Context

We're building a ShipMemory client for Mentra Live smart glasses. Same goal as the Android/Meta client: QR trigger → ContextCard → Gemini Live voice session. Different platform (TypeScript server-side app vs Android native).

Research revealed that **no existing Mentra example app matches our architecture**:
- Mentra-AI uses REST Gemini + text transcriptions (not Gemini Live WebSocket + raw audio)
- Camera Example only does single photo capture (not streaming)
- We need raw audio piping + WebRTC frame consumption — a fundamentally different pattern

**Starting template:** `MentraOS-Cloud-Example-App` — it has the right skeleton (Bun + Express + SDK v2 lifecycle) without the wrong AI stack (Mentra-AI's Mastra/REST approach would fight us).

**Reference client:** The Android/Meta client at `C:\Users\mikam\Local\oneshot-clients\shipmemory\clients\android-meta\` — we port the Gemini WebSocket, ContextCard parsing, SM1 decoder, and prompt template from Kotlin to TypeScript.

## Critical platform findings

### What works for us
- **Raw mic audio:** `session.events.onAudioChunk()` gives PCM 16kHz mono — pipe directly to Gemini Live
- **Camera streaming:** `session.camera.startStream()` returns `webrtcUrl` (Cloudflare WHEP) + `hlsUrl` — we consume this for QR scanning AND Gemini video input
- **Direct SRT mode:** `startStream({ direct: "srt://..." })` sends camera feed to our server with lowest latency

### The blocker: audio output
MentraOS has **no way to stream raw PCM to speakers**. Only `session.audio.speak(text)` (TTS) and `session.audio.playAudio({ audioUrl })` (file playback).

**Workaround — AUDIO mode + transcription:** Keep `responseModalities: ["AUDIO"]` (the model requires it). Gemini generates audio we can't play, but also provides `outputAudioTranscription` — text of what it said. We pipe that text through `session.audio.speak()` (TTS). The generated audio is discarded. Wasteful but invisible to the user.

**Future:** Request `session.audio.pushAudioChunk()` from Mentra team, or buffer Gemini audio chunks into a file and use `playAudio({ audioUrl })` for real Gemini voice.

## Architecture

```
┌──────────────────────────────────────────────────┐
│  Mentra Gemini App (base)                        │
│                                                  │
│  index.ts → AppServer lifecycle                  │
│  mentra/mic.ts → onAudioChunk → PCM chunks       │
│  mentra/camera.ts → startStream → webrtcUrl       │
│  mentra/display.ts → session.audio.speak (TTS)   │
│  gemini/liveClient.ts → Gemini Live WebSocket    │
│  gemini/setupMessage.ts → setup JSON from card   │
│  app/session.ts → IDLE|SCANNING|SESSION states   │
│  app/promptTemplate.ts → system prompt wrapper   │
│  bridge/ → WHEP consumer + frame sampling        │
│                                                  │
│  Boundary: ContextProvider interface             │
│         ↕                                        │
│  shipmemory/                                     │
│    types.ts → ContextCard, ContextProvider, Frame │
│    mock.ts → static card, ignores frames         │
│    service.ts → QR decode from WebRTC frames     │
│    qrDecoder.ts → jsQR on JPEG/PNG buffers       │
│    sm1.ts → Base45 + zlib decompress             │
│    urlFetch.ts → GET context from ship-edge      │
└──────────────────────────────────────────────────┘
```

### Boundary contract

```typescript
interface ContextProvider {
  scan(frames: AsyncIterable<Frame>): Promise<ContextCard>
}

interface ContextCard {
  body: string
  tools: ToolDeclaration[]
  execute_url: string | null
  session_id: string | null
  trace_url: string | null
}
```

**Boundary rules:**
- Base app never imports ShipMemory internals
- ShipMemory never imports Mentra SDK or Gemini code
- ShipMemory only receives frames via `scan()`
- Base app only gets context via `ContextProvider`
- Tool routing and trace submission live in ShipMemory
- System prompt template and Gemini WebSocket live in base app
- `bridge/` belongs to base app — it's frame routing infrastructure, not ShipMemory

### Camera frame path

WebRTC stream consumption via WHEP, not `requestPhoto()`:

```
session.camera.startStream()
  → webrtcUrl (Cloudflare WHEP endpoint)
  → WHEP client consumes stream server-side
  → raw video frames (~30fps from camera)
  → FrameSampler filters + throttles
  → SCANNING: ~3fps to ShipMemory for QR decode
  → SESSION: 1fps JPEG to Gemini as video input
```

**Ownership: `bridge/` belongs to the base app (Mentra side), not ShipMemory.** The bridge is frame routing infrastructure — it consumes the Mentra camera stream and feeds frames to whoever needs them. ShipMemory only receives frames through the `ContextProvider.scan()` interface. Another team could swap in a better WebRTC consumer without touching ShipMemory at all.

### Frame sampling & filtering pipeline

Two modes depending on app state:

**SCANNING mode (~3fps, QR detection):**
```
Raw frames (30fps)
  │
  ├─ Throttle: 1 frame per 333ms (~3fps)
  │
  ├─ Luminance check (<1ms):
  │     reject if avg luminance < 30 (too dark) or > 225 (blown out)
  │     LOG: "frame_skip reason=dark lum=22" or "frame_skip reason=bright lum=240"
  │
  ├─ Motion check (<2ms): perceptual hash vs last accepted frame
  │     reject if hamming distance < 3 (nothing changed)
  │     reject if hamming distance > 40 (motion blur)
  │     LOG: "frame_skip reason=static diff=1" or "frame_skip reason=blur diff=48"
  │
  ├─ QR decode attempt (5-20ms): jsQR on frame
  │     if found → LOG: "qr_detected payload_len=342 format=SM1"
  │     if not   → LOG: "frame_processed no_qr"
  │     continue scanning
  │
  └─ LOG periodic: "scan_stats fps_in=30 fps_accepted=2.8 fps_qr_attempts=2.1 elapsed=12s"
```

**SESSION mode (1fps, Gemini video input):**
```
Raw frames (30fps)
  │
  ├─ Throttle: 1 frame per 1000ms (1fps, matches Android client)
  │
  ├─ Same luminance + motion checks
  │     LOG: skip reasons same as above
  │
  ├─ Encode as JPEG 50% quality
  │
  └─ Forward to Gemini as realtimeInput.video
       LOG: "frame_sent_gemini size=42kb elapsed_since_last=1012ms"
```

**Frame sampler logging:**

| Log tag | When | Example |
|---------|------|---------|
| `Frame:throttle` | Frame dropped by rate limiter | `fps_in=30 fps_target=3 dropped=27` |
| `Frame:skip` | Frame rejected by quality filter | `reason=dark lum=18` / `reason=blur diff=52` |
| `Frame:accept` | Frame passed filters | `lum=128 diff=12 mode=scanning` |
| `Frame:qr` | QR decode attempted | `found=false` / `found=true len=342` |
| `Frame:gemini` | Frame sent to Gemini | `size=38kb seq=14` |
| `Frame:stats` | Periodic summary (every 5s) | `fps_in=30 fps_accepted=2.6 total_skipped=124 skip_reasons={dark:3,blur:8,static:113}` |

```typescript
class FrameSampler {
  private lastHash: number = 0
  private lastAcceptTime: number = 0
  private stats = { accepted: 0, skippedDark: 0, skippedBright: 0, skippedStatic: 0, skippedBlur: 0, total: 0 }
  private statsInterval: Timer

  constructor(private mode: 'scanning' | 'session', private log: Logger) {
    this.statsInterval = setInterval(() => this.logStats(), 5000)
  }

  get targetFps(): number {
    return this.mode === 'scanning' ? 3 : 1
  }

  shouldProcess(frame: Frame): { accept: boolean; reason?: string } {
    this.stats.total++
    const now = Date.now()
    const minInterval = 1000 / this.targetFps

    if (now - this.lastAcceptTime < minInterval) return { accept: false, reason: 'throttle' }

    const lum = avgLuminance(frame)
    if (lum < 30) { this.stats.skippedDark++; this.log('Frame:skip', { reason: 'dark', lum }); return { accept: false, reason: 'dark' } }
    if (lum > 225) { this.stats.skippedBright++; this.log('Frame:skip', { reason: 'bright', lum }); return { accept: false, reason: 'bright' } }

    const hash = perceptualHash(frame)
    const diff = hammingDistance(hash, this.lastHash)
    if (diff < 3) { this.stats.skippedStatic++; this.log('Frame:skip', { reason: 'static', diff }); return { accept: false, reason: 'static' } }
    if (diff > 40) { this.stats.skippedBlur++; this.log('Frame:skip', { reason: 'blur', diff }); return { accept: false, reason: 'blur' } }

    this.lastHash = hash
    this.lastAcceptTime = now
    this.stats.accepted++
    this.log('Frame:accept', { lum, diff, mode: this.mode })
    return { accept: true }
  }

  switchMode(mode: 'scanning' | 'session') {
    this.log('Frame:mode', { from: this.mode, to: mode, targetFps: mode === 'scanning' ? 3 : 1 })
    this.mode = mode
  }
}
```

### Audio path

```
IN:  Mic → onAudioChunk (PCM 16kHz) → base64 → Gemini Live WebSocket (realtimeInput.audio)
OUT: Gemini Live → outputTranscription.text → session.audio.speak() → glasses speakers
     (Gemini also sends audio chunks, but we discard them — MentraOS can't play raw PCM)
```

**Important discovery:** `gemini-3.1-flash-live-preview` is a native audio model — it ONLY supports `responseModalities: ["AUDIO"]`. TEXT mode is not possible with this model.

**Decision: Audio mode + outputTranscription → TTS.** Keep `["AUDIO"]` modality (required by model). Gemini produces audio we can't play directly (no raw PCM playback on MentraOS). Instead, use `outputAudioTranscription` to get the text of what Gemini said, then pipe through `session.audio.speak()`. The generated audio is discarded — wasteful but invisible to user. Can upgrade to buffer-and-URL approach later for real Gemini voice.

The setup message keeps the protocol-standard config:
```json
{
  "generationConfig": {
    "responseModalities": ["AUDIO"]
  },
  "outputAudioTranscription": {}
}
```
And we read from `serverContent.outputTranscription.text` → `session.audio.speak(text)`.

## What we're building (single pass, no phases)

### Base app (from Camera Example template)
- [ ] Clone MentraOS-Camera-Example-App as starting point
- [ ] Strip photo capture UI, SSE photo stream, webview components
- [ ] Keep: AppServer lifecycle, SessionManager, Bun.serve skeleton
- [ ] Add `mentra/mic.ts` — subscribe to `onAudioChunk`, expose PCM stream
- [ ] Add `mentra/camera.ts` — `startStream()`, expose frame source
- [ ] Add `mentra/display.ts` — TTS output via `session.audio.speak()` (fed from Gemini outputTranscription)
- [ ] Add `app/session.ts` — IDLE → SCANNING → SESSION state machine
- [ ] Add `app/promptTemplate.ts` — protocol v0.1 system prompt template
- [ ] Add `gemini/liveClient.ts` — Gemini Live WebSocket (port from Android, adapt to TS)
- [ ] Add `gemini/setupMessage.ts` — build setup JSON from ContextCard (AUDIO modality + outputAudioTranscription)
- [ ] Wire: mic chunks → Gemini audio in, Gemini outputTranscription → TTS out

### ShipMemory addon
- [ ] Add `shipmemory/types.ts` — ContextCard, ContextProvider, Frame interfaces
- [ ] Add `shipmemory/mock.ts` — MockShipMemoryService (static card after 1s delay)
- [ ] Add `shipmemory/service.ts` — real service (scan frames for QR)
- [ ] Add `shipmemory/qrDecoder.ts` — jsQR on frame buffers
- [ ] Add `shipmemory/sm1.ts` — Base45 decode + zlib inflate
- [ ] Add `shipmemory/urlFetch.ts` — fetch ContextCard from URL with whitelist

### WHEP frame extraction bridge
- [ ] Add `bridge/whepClient.ts` — WHEP consumer for Mentra `webrtcUrl` (Cloudflare endpoint)
- [ ] Add `bridge/frameSampler.ts` — dual-mode sampler (3fps scanning / 1fps session), luminance + motion filters, structured logging
- [ ] Add `bridge/frameUtils.ts` — `avgLuminance()`, `perceptualHash()`, `hammingDistance()`, JPEG encode
- [ ] Wire: frames → ShipMemory scan (SCANNING) + Gemini video input (SESSION)
- [ ] Frame stats logging every 5s: fps in/out, skip reasons breakdown, mode

## File structure

```
src/
  client/
    index.ts                    # Bun.serve + AppServer boot
    app/
      session.ts                # IDLE|SCANNING|SESSION orchestrator
      state.ts                  # State enum
      promptTemplate.ts         # Protocol v0.1 system prompt
    mentra/
      mic.ts                    # onAudioChunk subscription → PCM stream
      camera.ts                 # startStream, expose webrtcUrl/srtUrl
      display.ts                # TTS output wrapper
    gemini/
      liveClient.ts             # WebSocket transport + message types
      setupMessage.ts           # Build setup JSON from ContextCard
      audioCodec.ts             # PCM base64 encode/decode
    bridge/
      whepClient.ts             # WHEP consumer for webrtcUrl
      frameSampler.ts           # Dual-mode sampler (3fps scan / 1fps session) + logging
      frameUtils.ts             # Luminance, perceptual hash, JPEG encode
    shipmemory/
      types.ts                  # ContextCard, ContextProvider, Frame
      mock.ts                   # MockShipMemoryService
      service.ts                # Real ShipMemoryService
      qrDecoder.ts              # jsQR wrapper
      sm1.ts                    # SM1 decompress
      urlFetch.ts               # URL fetch + whitelist
    config/
      env.ts                    # Env var validation
```

Note: The existing bridge code (`src/index.ts`, `src/routes/`, `src/services/`) stays untouched. The Mentra client lives under `src/client/` as a separate entry point.

## Dependencies (to add)

```json
{
  "@mentra/sdk": "^2.0.3",
  "ws": "^8.18.1",
  "jsqr": "^1.4.0",
  "pako": "^2.1.0",
  "base45-js": "^1.0.0",
  "werift": "^0.19.0"
}
```

Note: The SDK is v2.x (Express-based), matching the MentraOS-Cloud-Example-App. Hono-based v3 does not exist yet.

Plus: FFmpeg installed on system (for H264 decode from werift NALUs).

## Key files to reference (in shipmemory monorepo)

These are read-only references for porting — no runtime dependency:

- `C:\Users\mikam\Local\oneshot-clients\shipmemory\clients\android-meta\..\gemini\GeminiLiveService.kt` — WebSocket setup, message parsing, tool call handling
- `C:\Users\mikam\Local\oneshot-clients\shipmemory\clients\android-meta\..\context\ContextCard.kt` — parsing logic
- `C:\Users\mikam\Local\oneshot-clients\shipmemory\clients\android-meta\..\context\QrDecoder.kt` — SM1 decode
- `C:\Users\mikam\Local\oneshot-clients\shipmemory\clients\android-meta\..\context\ContextCardPromptParser.kt` — system prompt
- Protocol spec: `C:\Users\mikam\Downloads\protocol.md`
- Camera Example: `github.com/Mentra-Community/MentraOS-Camera-Example-App` — starting skeleton

## Verification (on Mentra Live glasses)

1. **Mock mode:** App boots → connects to glasses via Mentra → mock scan returns static card → Gemini Live WebSocket opens → speak into glasses mic → hear TTS response through speakers
2. **QR mode:** App boots → camera stream starts → WHEP client consumes webrtcUrl → frames extracted → hold QR code up to glasses → QR detected → ContextCard loaded → Gemini session starts with card.body as context
3. **Audio round-trip:** Say something → onAudioChunk delivers PCM → sent to Gemini → text response → session.audio.speak() → hear answer
4. **Boundary check:** `shipmemory/` has zero imports from `mentra/` or `gemini/`. Base app has zero imports from `shipmemory/` except through `ContextProvider` interface.

## Dev setup

Local + ngrok. Standard Mentra dev workflow:

```
Your machine (Bun)          ngrok           Mentra Cloud        Glasses
  localhost:3000  ──────►  public URL  ──────►  routes to  ──────►  Mentra Live
       ↑
  full logs in terminal (frame stats, Gemini msgs, state transitions)
```

```bash
bun install
cp .env.example .env   # fill in MENTRAOS_API_KEY, PACKAGE_NAME, GEMINI_API_KEY
bun run dev:client      # new script for client entry point
ngrok http --url=<YOUR_NGROK_URL> 3000
```

## Decision log (with reasoning)

| # | Decision | Why |
|---|----------|-----|
| 1 | **werift + FFmpeg** for frame extraction | werift is pure TS — no native deps, deploys anywhere (Railway, Docker, local). But it gives H264 NALUs, not pixels. FFmpeg is the cheapest bridge to raw frames via subprocess pipe. |
| 2 | **AUDIO mode + discard audio + TTS** | `gemini-3.1-flash-live-preview` only supports `["AUDIO"]` — TEXT mode isn't an option. We waste the generated audio but get `outputAudioTranscription` for free, which `session.audio.speak()` can voice. |
| 3 | **WHEP not requestPhoto()** | `requestPhoto()` is a slow round-trip per frame. WHEP gives a continuous 30fps stream we sample from — needed for real-time QR scanning at 3fps. |
| 4 | **ContextProvider interface boundary** | Keeps ShipMemory swappable. The base app is a generic "talk to Gemini with your glasses" app that works without ShipMemory. MockShipMemoryService proves this — one-line swap. |
| 5 | **bridge/ owned by base app, not ShipMemory** | The bridge is Mentra-side frame routing. Someone else could build a better WebRTC consumer without touching ShipMemory. ShipMemory only receives frames via `scan()`. |
| 6 | **SRT available but starting with WHEP** | SRT (`startStream({ direct: "srt://..." })`) is lower latency but requires the glasses and server on the same network. WHEP works over the internet via Cloudflare. Can revisit SRT for on-prem deployments. |
| 7 | **Camera Example as template, not Mentra-AI** | Mentra-AI uses REST Gemini + Mastra — would fight our Gemini Live WebSocket architecture. Camera Example has the right skeleton (Bun + Express + SDK lifecycle) without the wrong AI stack. |
| 8 | **Dev: local Bun + ngrok** | Full logs in terminal, fast iteration. Standard Mentra dev workflow. |
| 9 | **Deploy: Railway + nixpacks** | `aptPkgs = ["ffmpeg"]` in nixpacks config gives us FFmpeg without a custom Dockerfile. Fine for 1-20 concurrent sessions. |
| 10 | **Build in separate repo, opensource** | Zero runtime deps on shipmemory monorepo. Android files are read-only porting reference. Cleaner git history, independent CI/CD, shareable with Mentra community. |
| 11 | **Stay on Gemini Live (for now) despite audio waste** | Investigated three alternatives. Current choice is pragmatic — revisit if cost or model flexibility becomes a blocker. See "Audio architecture options" below. |

## Audio architecture options (investigated 2026-04-16)

Mentra has a **built-in STT pipeline** (Soniox/Azure providers) via `session.events.onTranscription()` with per-word confidence scores, speaker diarization, and language detection. This opened the question: should we bypass Gemini Live entirely?

Also investigated: `AudioOutputStream.write()` was suggested as a way to stream raw PCM to glasses speakers. **This does not exist.** Mentra SDK audio output is limited to `playAudio({ audioUrl })` (file from URL) and `speak(text)` (ElevenLabs TTS). No raw PCM streaming. Confirmed via SDK types and [official docs](https://docs.mentraglass.com/app-devs/reference/managers/audio-manager).

### Option 1: Gemini Live + discard audio + TTS (current plan) ✅

```
Mic → onAudioChunk (PCM 16kHz) → Gemini Live WebSocket
  → Gemini generates audio (discarded) + outputAudioTranscription
  → session.audio.speak(text) → ElevenLabs TTS → glasses speakers
```

**Pros:** Lowest latency (single hop). Built-in turn-taking, barge-in, VAD. Least code.
**Cons:** Wastes audio generation tokens. Locked to Gemini Live models (`gemini-3.1-flash-live-preview`). Can't use Claude/GPT/etc.

### Option 2: Mentra STT + generateContent API

```
Mic → Mentra cloud STT (Soniox/Azure) → TranscriptionData.text
  + Camera frames (JPEG) as inlineData
  → Gemini generateContent (text+image in → text out)
  → session.audio.speak(text) → ElevenLabs TTS → glasses speakers
```

**Pros:** No wasted audio tokens. Any multimodal model (Gemini, Claude, GPT). STT confidence scores. Vision works (text+image → text supported by `gemini-3-flash-preview` and others).
**Cons:** Higher latency (3 hops: STT → model → TTS). Must build turn management manually (VAD + conversation history). More code.

**Switch when:** Need model flexibility, need STT confidence scores, or audio waste becomes a cost problem.

### Option 3: Wait for Mentra `pushAudioChunk()` (future)

```
Mic → Gemini Live → Gemini audio response
  → pushAudioChunk() → glasses speakers (native Gemini voice)
```

**Pros:** Zero waste. Native Gemini voice quality. No ElevenLabs dependency.
**Cons:** Requires Mentra to ship `pushAudioChunk()` or equivalent raw PCM output API. Not on their public roadmap.

**Switch when:** Mentra adds raw audio output to the SDK.
