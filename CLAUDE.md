# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**ShipMemory Bridge** is an open-source HTTP service that resolves QR lookup keys to ContextCards stored on an Auki Domain. Agents scan a QR code, hit the resolve endpoint, and get back a ContextCard (system prompt + tools + execute_url) to start a session.

## Commands

| Task | Command |
|------|---------|
| Install | `bun install` |
| Dev (hot reload) | `bun run dev` (port 3000) |
| Build | `bun run build` (runs `tsc`) |
| Start (prod) | `bun run start` (`node dist/index.js`) |
| Type check | `bun run lint` (`tsc --noEmit`) |

## Auth Model

The bridge holds its own Auki credentials (env vars). Clients authenticate with a simple `?key=` query param.

- **Bridge → Auki:** Logs in on startup with `AUKI_EMAIL`/`AUKI_PASSWORD`, caches domain token via `BridgeAuth`, auto-refreshes before expiry
- **Client → Bridge:** All endpoints gated by `?key=` matching `API_KEY` env var
- **Clients never touch Auki auth** — the bridge is the only thing that talks to Auki

### Auki 3-tier token flow (handled by BridgeAuth on startup):
```
1. POST {AUKI_API_BASE}/user/login                    → session access_token
2. POST {AUKI_API_BASE}/service/domains-access-token   → domains access_token
3. POST {AUKI_DDS_BASE}/api/v1/domains/{id}/auth       → domain_token + domain_server.url
```

## Architecture

```
src/
├── index.ts                    # Express app, BridgeAuth.init(), route mounting
├── schemas/
│   └── contextcard.ts          # Zod schema matching ContextCard.kt
├── services/
│   ├── AukiAuthService.ts      # AukiAuthService (stateless helpers) + BridgeAuth (cached server-side auth)
│   └── DomainStorageService.ts # store, load, listByType, delete against Auki domain HTTP API
├── middleware/
│   ├── apiKey.ts               # Validates ?key= query param against API_KEY env var
│   └── domainAuth.ts           # (Legacy, unused) Per-request domain auth from headers
└── routes/
    ├── auth.ts                 # POST /auth/login (proxy to Auki)
    ├── resolve.ts              # GET /resolve/:key — QR registry lookup → ContextCard
    ├── card.ts                 # GET /card (list with full content + registry keys), GET /card/:id
    ├── session.ts              # GET/POST session data (per-session scoping)
    ├── qr.ts                   # GET /qr/:key — get or generate QR PNG
    ├── deploy.ts               # POST/PUT/DELETE /deploy — full card lifecycle
    └── ui.ts                   # Serves public/index.html
public/
└── index.html                  # SPA: API key login, deploy cards, view QR codes, delete cards
```

## QR + Resolve Flow (asset-folder layout)

```
Deploy: User fills card ID + body in web UI
  → POST /deploy mints a fresh asset_id (UUID) and writes:
      asset:<asset_id>/card  (ContextCard JSON)
      asset:<asset_id>/qr    (PNG)
      registry/<key>         ({ asset_id, key })
  → QR encodes: https://{BRIDGE_BASE_URL}/resolve/{key}

Resolve: client GETs /resolve/{key}?key=...
  → Bridge: listByType('registry') → find name==key → load → asset_id
  → Bridge: listByType('asset:<asset_id>') → find name=='card' → load
  → Validates, injects asset_id into response, returns ContextCard JSON

Tool calls (session transcript) target the asset folder via asset_id:
  POST /session/:asset_id/transcript   (append a role-based entry)
  GET  /session/:asset_id/transcript   (read entries; optional ?session_id=...)

Agent tool dispatcher (set as execute_url when a card uses built-in tools):
  POST /tool/:asset_id                 body { tool: "session_history", params: {...} }
```

Tool presets live on the domain under `tool_preset`. Built-in `session_history`
is seeded on first boot; cards reference presets via `tool_refs: ["..."]` which
/resolve expands into full tool definitions on the way out. This keeps stored
cards small while the resolved response still looks identical to what the
Android client expects.

Legacy flat layout (`contextcard`, `qr_registry`, `qr_image`, `session:{card_id}:{data_key}`) is still readable by `/resolve`, `/card`, `/qr`, and `/inventory` for backwards compatibility, but new deploys always write the asset-folder layout.

## ContextCard Schema

Matches the shipmemory Android client (`ContextCard.kt`) exactly:

```json
{
  "body": "system prompt text (required, non-empty)",
  "tools": [{ "name": "...", "description": "...", "parameters": {...} }],
  "execute_url": "https://... (optional)"
}
```

- `body` is the system prompt — the Android app injects it into the Gemini Live session
- If the QR contains a URL (starts with `https://`), the app fetches it and parses the response as this JSON
- The app appends `?key={contextApiKey}` automatically (default: `oneshot-dev`)
- Reference client: `C:\Users\mikam\Local\oneshot-clients\shipmemory`

## Domain Data Types

Current (asset-folder):

| Data type | Name convention | Purpose |
|---|---|---|
| `registry` | `{key}` | `{ asset_id, key }` — QR lookup key → asset folder |
| `tool_preset` | `{preset_name}` | Tool definition the agent sees. Built-ins seeded on boot (`session_history`). |
| `asset:{asset_id}` | `card` | ContextCard JSON |
| `asset:{asset_id}` | `qr` | QR code PNG |
| `asset:{asset_id}` | `session:{sid}:{turn}` | Transcript entry (append-only, zero-padded turn) |

Legacy (still readable, not written):

| Data type | Purpose |
|---|---|
| `contextcard` | Free-standing ContextCard JSON |
| `qr_registry` | `{ card_id, key }` — key → contextcard data_id |
| `qr_image` | QR PNGs named `qr_{key}` |
| `session:{card_id}:{data_key}` | Per-(card,key) buckets |

## Auki Domain API

```
STORE:  POST {domainServerUrl}/api/v1/domains/{domainId}/data
        multipart/form-data, data-type in Content-Disposition, unique filenames required

LOAD:   GET {domainServerUrl}/api/v1/domains/{domainId}/data/{dataId}?raw=1

LIST:   GET {domainServerUrl}/api/v1/domains/{domainId}/data?data_type={type}

DELETE: DELETE {domainServerUrl}/api/v1/domains/{domainId}/data/{dataId}
```

## Environment Variables

```env
PORT=3000
BRIDGE_BASE_URL=https://your-bridge.up.railway.app  # Used in QR code URLs
API_KEY=your-secret-key                               # Client auth

AUKI_EMAIL=your@email.com          # Bridge's own Auki login
AUKI_PASSWORD=yourpassword
AUKI_DOMAIN_ID=your-domain-id
AUKI_API_BASE_URL=https://api.auki.network
AUKI_DDS_BASE_URL=https://dds.auki.network
```

## Mentra Live Client (new — see PLAN_MENTRA_CLIENT.md)

This repo now also contains a **Mentra Live smart glasses client** under `src/client/`. It's a separate entry point from the bridge.

**What it does:** QR trigger → ContextCard → Gemini Live voice session on Mentra Live glasses. Same goal as the Android/Meta client in the shipmemory monorepo, ported to TypeScript on MentraOS.

**Why it's here:** Zero runtime dependency on the shipmemory monorepo. Built here for clean git history and open-source release. The bridge (`src/index.ts`, `src/routes/`, `src/services/`) is untouched — the client is additive.

**Key architecture decisions:**
- ShipMemory is a pluggable addon behind a `ContextProvider` interface — the base Mentra app works without it
- `bridge/` (WHEP frame consumer) belongs to the base app, not ShipMemory
- Audio output via `outputAudioTranscription` → TTS (Gemini model only supports AUDIO mode, MentraOS can't play raw PCM)
- Frame extraction via werift (pure TS WebRTC) + FFmpeg subprocess

**Full plan:** `PLAN_MENTRA_CLIENT.md` — includes architecture, boundary rules, decision log with reasoning, and build checklist.

**Reference files for porting (read-only, in shipmemory monorepo):**
- `C:\Users\mikam\Local\oneshot-clients\shipmemory\clients\android-meta\` — Android Gemini client, ContextCard parsing, SM1 decoder, prompt template
- `C:\Users\mikam\Downloads\protocol.md` — ShipMemory Protocol v0.1 spec

## Reference Projects

- **Auki Contextualizer** (`C:\Users\mikam\Local\Auki\Auki-Contextualizer`) — Working AukiAuthService + DomainStorageService patterns
- **ShipMemory client** (`C:\Users\mikam\Local\oneshot-clients\shipmemory`) — Android app that consumes ContextCards, defines the schema contract
