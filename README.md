# ShipMemory × Auki × Mentra

Open-source reference stack for location-aware, QR-triggered voice agents on smart glasses.

The repo contains three separable components that share one data contract:

| # | Component | What it is | Lives in |
|---|---|---|---|
| 1 | **ShipMemory Protocol** | The open data contract — ContextCard schema + QR payload formats | `src/schemas/` + docs below |
| 2 | **Auki Bridge** | HTTP service that stores ContextCards on an Auki Domain and resolves QR lookup keys | `src/index.ts`, `src/routes/`, `src/services/` |
| 3 | **Mentra App (Gemini Live)** | MentraOS app for Mentra Live glasses — scans QR, fetches ContextCard, runs Gemini Live voice session | `src/client/` |

```
┌────────────────────┐     scan     ┌──────────────────┐   ?key=    ┌────────────────┐   Auki API   ┌──────────────┐
│ 3. Mentra App      │  ─────────→  │ QR (URL payload) │  ───────→  │ 2. Auki Bridge │  ─────────→  │ Auki Domain  │
│   (Gemini Live)    │              └──────────────────┘            │  (this repo)   │              │  (storage)   │
└────────────────────┘                                              └────────────────┘              └──────────────┘
          ▲                                                                 │
          │                         ContextCard JSON                        │
          └─────────────────────────────────────────────────────────────────┘
                       (1. ShipMemory Protocol — the shared contract)
```

Each component can be used independently:

- Run the **Bridge** without the Mentra App — any QR-scanning agent (Android, iOS, web) can resolve cards.
- Run the **Mentra App** without the Bridge — use `CONTEXT_CARD_URL` to point at any protocol-compliant endpoint, or fall back to the mock provider.
- Implement the **Protocol** with a different backend — the Bridge is one reference implementation.

---

## 1. ShipMemory Protocol

The contract that binds the pieces together. Any scanner and any resolver that implement this protocol interoperate.

### 1.1 ContextCard

JSON object returned from a resolver endpoint. Matches the Android reference client (`ContextCard.kt`) exactly.

```json
{
  "body": "You are a field service assistant for the STM Waterjet Premium...",
  "tools": [
    {
      "name": "get_procedure",
      "description": "Get step-by-step maintenance procedure",
      "parameters": {
        "type": "object",
        "properties": { "procedure_id": { "type": "string" } },
        "required": ["procedure_id"]
      }
    }
  ],
  "execute_url": "https://your-backend.com/api/execute",
  "session_id": null,
  "trace_url": null
}
```

| Field | Required | Description |
|---|---|---|
| `body` | yes | System prompt injected into the agent/voice session |
| `tools` | no | Tool declarations (name, description, JSON Schema parameters) |
| `execute_url` | no | URL the agent POSTs tool calls to |
| `session_id` | no | Opaque session identifier assigned by the resolver |
| `trace_url` | no | URL the agent POSTs transcript/trace data to |

Zod schema: [`src/schemas/contextcard.ts`](src/schemas/contextcard.ts).

### 1.2 QR payload formats

A scanner MUST accept all three formats:

| Format | Example | Meaning |
|---|---|---|
| **URL** | `https://bridge.example.com/resolve/my-card` | Fetch a ContextCard from that URL (append `?key=` if the scanner holds an API key) |
| **SM1 inline** | `SM1:XQC03...` | Base45-decode then zlib-inflate to get inline JSON or a URL. Lets a single QR carry a full card without a network round-trip |
| **Plain text** | `You are a helpful assistant...` | Use the string directly as `body`; no tools, no execute_url |

Decoder: [`src/client/shipmemory/sm1.ts`](src/client/shipmemory/sm1.ts).

### 1.3 Allowlist

A scanner SHOULD enforce a URL prefix allowlist against the QR payload, `execute_url`, and `trace_url` before connecting to any of them. This prevents a hostile QR code from pointing the agent at an attacker-controlled server. Reference: [`src/client/shipmemory/allowlist.ts`](src/client/shipmemory/allowlist.ts).

---

## 2. Auki Bridge

A TypeScript/Express service that stores ContextCards on an Auki Domain and exposes a QR-resolvable HTTP API. Entry point: [`src/index.ts`](src/index.ts).

### 2.1 Auth model

| Who | Authenticates how | Against what |
|---|---|---|
| Bridge → Auki | Email / password on startup (env vars) | Auki Network 3-tier JWT flow |
| Client → Bridge | `?key=` query param on every request | Bridge's `API_KEY` env var |

The bridge owns the Auki credentials, caches the domain token, and auto-refreshes before expiry. Clients never touch Auki — they only need the bridge's API key. Each operator hosts their own bridge with their own domain.

### 2.2 Resolve flow

```
GET /resolve/my-machine?key=xxx
  │
  ├─ 1. List qr_registry entries on the domain
  ├─ 2. Find entry where name === "my-machine"
  ├─ 3. Load registry JSON → get card data ID
  ├─ 4. Load card, validate against ContextCard schema
  └─ 5. Return JSON
```

The QR registry `name` must match the card ID in the resolve URL. `POST /deploy` handles this automatically.

### 2.3 API

| Method | Path | Description |
|---|---|---|
| `GET` | `/resolve/:key` | QR lookup → ContextCard JSON |
| `GET` | `/card` | List all cards (full content + registry keys) |
| `GET` | `/card/:id` | Fetch single card by data ID |
| `GET` | `/card/:id/tools` | Tools array from a card |
| `POST` | `/deploy` | Deploy card + QR registry + QR image |
| `PUT` | `/deploy/:id` | Update a card's body/tools |
| `DELETE` | `/deploy/:id` | Delete card + registry + QR image |
| `GET` | `/qr/:key` | Get or generate QR code PNG |
| `GET` | `/session/:card_id/data/:key` | Read session data |
| `POST` | `/session/:card_id/data` | Write session data |
| `POST` | `/auth/login` | Proxy Auki login (returns tokens) |
| `GET` | `/health` | Health check |

All endpoints gated by `?key=`.

### 2.4 Domain data types

| Type | Purpose | Created by |
|---|---|---|
| `contextcard` | ContextCard JSON | `/deploy` |
| `qr_registry` | Maps lookup key (name) → card data ID | `/deploy` |
| `qr_image` | QR code PNG (name: `qr_{key}`) | `/deploy`, `/qr` |
| `session:{card_id}:{data_key}` | Per-session scoped tool data | `/session` |

### 2.5 Web UI

The dashboard at `/ui` lets an operator deploy new cards, view all cards on the domain with inline QR thumbnails, zoom/download QR codes, and delete cards. Auth is a single API key stored in `localStorage`.

### 2.6 Run locally

```bash
cp .env.example .env   # fill in AUKI_*, API_KEY, BRIDGE_BASE_URL
bun install
bun run dev            # port 3000
```

```
[BridgeAuth] Logging in as your@email.com...
[BridgeAuth] Ready
ShipMemory Bridge running on port 3000
```

Deploy your first card:

```bash
curl -X POST "http://localhost:3000/deploy?key=your-secret-key" \
  -H "Content-Type: application/json" \
  -d '{"id": "my-machine", "body": "You are a maintenance assistant for..."}'
```

Open `http://localhost:3000/ui` to see the QR code and scan it.

---

## 3. Mentra App (Gemini Live)

A MentraOS app for Mentra Live smart glasses that scans a QR code, loads the resolved ContextCard, and runs a Gemini Live voice session with those tools. Entry point: [`src/client/index.ts`](src/client/index.ts).

Separate process from the bridge. Can run standalone (mock mode) or against any ShipMemory-compliant resolver.

### 3.1 Lifecycle

```
App launch on glasses
  │
  ├─ onSession → orchestrator created, waits for user
  ├─ User opens webview, taps Start          ← explicit gate (avoids Mentra switching_clouds churn)
  ├─ Camera stream starts (WHEP WebRTC)
  ├─ Frames consumed → QR decode loop (~3 fps)
  ├─ QR found → decode (URL / SM1 / plain text) → fetch ContextCard
  ├─ Build Gemini Live setup from ContextCard (system prompt + tools)
  ├─ Gemini Live WebSocket opens → mic audio streamed in, 1 fps JPEG video streamed in
  └─ Voice session: transcription → TTS (AUDIO-mode workaround, see 3.3)
```

### 3.2 Architecture

```
src/client/
├── index.ts                      AppServer, lifecycle, webview routes
├── app/
│   ├── session.ts                SessionOrchestrator — state machine
│   ├── state.ts                  IDLE | SCANNING | SESSION
│   └── promptTemplate.ts         Wraps ContextCard.body in the voice-agent template
├── mentra/
│   ├── mic.ts                    onAudioChunk → PCM pipe
│   ├── camera.ts                 startStream → WHEP URL
│   └── display.ts                session.audio.speak (TTS)
├── bridge/                       (frame infra — NOT the Auki Bridge)
│   ├── whepClient.ts             Pure-TS WHEP consumer via werift
│   └── frameConverter.ts         Decoded video → RGBA + JPEG frames
├── gemini/
│   ├── liveClient.ts             Gemini Live WebSocket client
│   ├── setupMessage.ts           Builds Gemini setup JSON from a ContextCard
│   └── audioCodec.ts             PCM encoding
├── shipmemory/                   Protocol implementation (pluggable)
│   ├── types.ts                  ContextCard, ContextProvider, Frame
│   ├── service.ts                Real provider: QR scan from frames → resolve
│   ├── mock.ts                   Static card / hardcoded-URL providers
│   ├── qrDecoder.ts              jsQR wrapper
│   ├── sm1.ts                    Base45 + zlib decompress
│   ├── urlFetch.ts               Fetch + parse ContextCard JSON
│   └── allowlist.ts              URL prefix allowlist
└── config/env.ts                 Env var loader
```

**Boundary rule:** `app/` and `mentra/` never import `shipmemory/` internals — only the `ContextProvider` interface. This keeps the protocol layer swappable.

### 3.3 The audio-output workaround

MentraOS has no API to stream raw PCM to the glasses speakers. Gemini Live in `AUDIO` mode generates PCM we can't play. The workaround: keep `responseModalities: ["AUDIO"]` (the live model requires it), enable `outputAudioTranscription`, discard the audio, and route the transcription through `session.audio.speak()` (MentraOS TTS). Invisible to the user; wasteful in tokens. Future fix requires a `session.audio.pushAudioChunk()` API from Mentra.

### 3.4 Context provider modes

Picked from env at startup:

| Env set | Provider | Behavior |
|---|---|---|
| `CONTEXT_CARD_URL` | `HardcodedUrlProvider` | Fetch card from that URL — no QR scan |
| `BRIDGE_BASE_URL` | `ShipMemoryService` | Scan frames for QR, resolve via bridge |
| *(neither)* | `MockShipMemoryService` | Static card — useful for testing the voice loop without a bridge |

### 3.5 Run locally

```bash
# .env needs: PACKAGE_NAME, MENTRAOS_API_KEY, GEMINI_API_KEY (+ optional BRIDGE_*)
bun install
bun run dev:client     # port 3000
```

Install the app on your Mentra Live glasses via the MentraOS developer console, point it at your public URL (ngrok or Railway), then open the webview and tap **Start**.

---

## Environment variables

```env
# Shared
PORT=3000

# --- Auki Bridge ---
BRIDGE_BASE_URL=https://your-bridge.up.railway.app   # Public URL baked into QR codes
API_KEY=your-secret-key                              # Client → Bridge auth
AUKI_EMAIL=your@email.com
AUKI_PASSWORD=your-password
AUKI_DOMAIN_ID=your-domain-id
AUKI_API_BASE_URL=https://api.auki.network
AUKI_DDS_BASE_URL=https://dds.auki.network

# --- Mentra App ---
PACKAGE_NAME=com.yourorg.yourapp
MENTRAOS_API_KEY=your-mentra-api-key
GEMINI_API_KEY=your-gemini-api-key
BRIDGE_API_KEY=your-secret-key                       # Usually same as API_KEY above
# CONTEXT_CARD_URL=                                  # Skip QR, fetch this URL directly
# ALLOWED_URL_PREFIXES=https://bridge1,https://bridge2   # Defaults to BRIDGE_BASE_URL
```

## Commands

| Task | Command |
|---|---|
| Install | `bun install` |
| Bridge dev | `bun run dev` |
| Mentra client dev | `bun run dev:client` |
| Build | `bun run build` |
| Type check | `bun run lint` |

## Deploy

Both components ship as separate containers and are typically deployed as two Railway services:

| Service | Dockerfile | Role |
|---|---|---|
| Bridge | `Dockerfile.bridge` | Public HTTP — stores/resolves cards, serves `/ui` |
| Mentra App | `Dockerfile.client` | Public HTTPS — MentraOS webhook target + webview |

On Railway, the Mentra App can reach the Bridge over private networking: set `CONTEXT_CARD_URL=http://bridge.railway.internal:3000/resolve/my-card` or `BRIDGE_BASE_URL=http://bridge.railway.internal:3000`.

For local development with real glasses, tunnel each public-facing service with `ngrok http 3000`.

## License

Apache 2.0
