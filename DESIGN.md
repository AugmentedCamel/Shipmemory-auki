# ShipMemory Bridge — Design Document

A thin, stateless, open-source HTTP service that resolves lookup keys to ContextCards stored on an Auki Domain. It enforces a locked data format so any agent app can build on it. No business logic, no AI calls, no session orchestration — just resolve, read, write.

---

## What it is

- A resolver: QR scan → lookup key → ContextCard
- A format gate: validates everything in/out against the ContextCard schema
- A pass-through: auth goes straight to Auki, callers burn their own tokens
- A contract: any client that speaks this format is compatible

## What it is NOT

- Not a ContextCard editor or management UI
- Not an AI layer (no Gemini, no Claude, no LLM calls)
- Not a session orchestrator
- Not a proprietary platform (that sits behind this later)

---

## Hosting model

| Mode | Who runs it | Domain |
|---|---|---|
| **Local** | Developer runs bridge on their machine | Points at Auki cloud domain |
| **Cloud** | Deployed as a service | Points at Auki cloud domain |
| **Self-hosted domain** | (Future) Full self-hosted stack | Points at self-hosted domain server |

In all modes the bridge is identical. Only the domain endpoint and credentials change.

---

## Auth model

The bridge holds no user state. Auth is pass-through.

1. Client app authenticates with Auki credentials (email + password or OIDC token)
2. Bridge forwards credentials to Auki `domain-http` API
3. Auki validates and deducts credits from the caller's account
4. Bridge never stores credentials — stateless per request

For a proprietary deployment, the same bridge API shape works but auth routes to a different backend. The client never knows the difference.

---

## Core API

### Resolve

```
GET /resolve/{key}
```

QR lookup key → full ContextCard. The key maps to a `qr_registry` data object on the domain, which points at a `contextcard` data object. Bridge fetches, validates schema, returns.

### Read card

```
GET /card/{id}
```

Fetch a ContextCard by its domain data ID. Bridge validates it conforms to the locked schema before returning.

### List tools

```
GET /tools/{card_id}
```

Returns the `tools` array from a card. Convenience endpoint — same data as the card, just the tools slice.

### Read session data (tool calls)

```
GET /session/{card_id}/data/{data_key}
```

Agent tool calls that read live or stored data resolve here. Bridge reads from the domain using the `data_key` and returns.

### Write session data

```
POST /session/{card_id}/data
```

Write session artifacts (transcript, trace, inspection results) to the domain. Bridge validates against the tool's write schema before storing.

---

## Data on the Auki Domain

Using Auki's typed data model (`name`, `type`, `content_type`, `payload`):

| Auki data type | Purpose | Written by |
|---|---|---|
| `contextcard` | Prompt card + tool definitions | Card author (out of scope of bridge) |
| `qr_registry` | Maps short lookup keys → card IDs | Card author (out of scope of bridge) |
| `session` | Transcript, trace, tool call results | Bridge (from client write-back) |

The bridge only writes `session` type data. `contextcard` and `qr_registry` are authored externally — how people create and manage cards is not part of this project.

---

## QR code flow

```
QR encodes:  "sm://bridge.example.com/resolve/stm-waterjet-premium"
                        |
                        v
Client scans QR → extracts key "stm-waterjet-premium"
                        |
                        v
Client calls   GET /resolve/stm-waterjet-premium
                        |
                        v
Bridge queries Auki domain:
  1. GetDataByType("qr_registry") → find entry with name "stm-waterjet-premium"
  2. Entry contains card_id → GetData(card_id)
  3. Validate payload against ContextCard schema
                        |
                        v
Bridge returns ContextCard JSON → client starts voice session
```

The QR code itself (PNG) can also be stored on the domain as a separate data object, but the QR **content** is just the resolve URL — a pointer, not the payload.

---

## ContextCard Format (v1)

This is the locked schema. The bridge enforces it. Every compliant agent app speaks this format.

```json
{
  "version": "1",
  "id": "stm-waterjet-premium",
  "name": "STM Waterjet Premium",
  "description": "Maintenance context for STM waterjet cutting system",

  "prompt": {
    "system": "You are a field service assistant for the STM Waterjet Premium. The operator is wearing smart glasses and speaking to you hands-free while working on the machine. Be concise, safety-first, and reference part numbers when relevant.",
    "greeting": "I see you're at the waterjet. What do you need help with?"
  },

  "tools": [
    {
      "name": "read_pressure",
      "description": "Read current cutting head pressure in PSI",
      "type": "session_read",
      "data_key": "telemetry.pressure"
    },
    {
      "name": "read_maintenance_log",
      "description": "Get recent maintenance entries for this machine",
      "type": "session_read",
      "data_key": "maintenance.log"
    },
    {
      "name": "write_inspection",
      "description": "Log an inspection result from this session",
      "type": "session_write",
      "data_key": "inspections",
      "schema": {
        "type": "object",
        "properties": {
          "component": { "type": "string" },
          "status": { "type": "string", "enum": ["pass", "fail", "needs_attention"] },
          "notes": { "type": "string" }
        },
        "required": ["component", "status"]
      }
    }
  ],

  "meta": {
    "author": "acme-industrial",
    "created": "2026-03-15T00:00:00Z",
    "updated": "2026-04-01T00:00:00Z",
    "tags": ["waterjet", "manufacturing", "maintenance"]
  }
}
```

### Field definitions

#### `version` (required)
Schema version string. Bridge rejects cards with unknown versions. Starts at `"1"`. Bumped only on breaking changes.

#### `id` (required)
Unique identifier within a domain. This is the resolve target — what the QR lookup key points to. Must be URL-safe (alphanumeric, hyphens, underscores).

#### `name` (required)
Human-readable display name. For UIs, logs, card listings. Not sent to the model.

#### `description` (optional)
Human-readable description. For discoverability and documentation. Not sent to the model.

#### `prompt` (required)

The context payload that drives the voice session.

- **`system`** (required) — System prompt injected into the voice session. This is the core value: the compiled, asset-specific context. No length limit enforced by the bridge (the model has its own limits).
- **`greeting`** (optional) — First message the agent speaks aloud. Gives the user immediate confirmation that the right card loaded. If absent, the agent listens silently until the user speaks.

#### `tools[]` (optional)

Array of capabilities the agent can invoke during the session. If empty or absent, the session is voice-only with no data read/write.

Each tool:

| Field | Required | Description |
|---|---|---|
| `name` | yes | Function name the model calls. Must be unique within the card. |
| `description` | yes | Tells the model when and why to use this tool. |
| `type` | yes | One of: `session_read`, `session_write`, `external` |
| `data_key` | yes | Domain data object key to read from or write to. |
| `schema` | no | JSON Schema for write payloads. Bridge validates before writing. Only relevant for `session_write`. |

**Tool types:**

- **`session_read`** — Reads a data object from the domain via `GET /session/{card_id}/data/{data_key}`. The data must already exist on the domain (written by telemetry, prior sessions, or external systems).
- **`session_write`** — Writes data to the domain via `POST /session/{card_id}/data`. If `schema` is present, bridge validates the payload before writing.
- **`external`** — (Reserved, not in v1) Will call an external URL. This is the hook where proprietary platform logic plugs in later. Bridge returns 501 for `external` tools in v1.

#### `meta` (optional)

Authorship and discoverability metadata. Bridge passes it through but does not act on it.

- **`author`** — Who created the card (org or individual identifier)
- **`created`** — ISO 8601 timestamp
- **`updated`** — ISO 8601 timestamp, updated on card modification
- **`tags`** — Array of strings for search and filtering

### What is intentionally NOT in the format

| Excluded | Why |
|---|---|
| Auth / permissions per card | Handled at the Auki domain level |
| BLE UUIDs or transport config | Transport is a client concern, not a card concern |
| Model selection | The client decides (Gemini Live, GPT, Claude, etc.) |
| Session lifecycle config | Timeouts, reconnect policy are client decisions |
| Nested cards or inheritance | Keep it flat. Composition happens at the platform layer |
| Binary assets (images, audio, 3D) | Stored as separate domain data objects, referenced by key if needed |
| SM1 compression | Compression is a QR encoding concern, not a card format concern |

---

## Proprietary layer (not open source)

The bridge is the open contract. A proprietary platform can sit between the bridge API and the domain (or replace the domain entirely) to add:

- **Live telemetry injection** — real `read_pressure` hitting actual sensors instead of stored values
- **Context compilation** — turning raw manuals into optimized `prompt.system` content
- **Session analytics** — processing transcripts and traces from `session` data
- **Fleet management** — which cards are deployed where, version control, rollback
- **`external` tool resolution** — routing tool calls to proprietary cloud endpoints
- **Access control** — per-card, per-org, per-user permissions beyond Auki's domain-level auth

The client never changes. Same API shape, same ContextCard format. The bridge URL is the only thing that differs.

---

## Open design decisions

### 1. Session scoping

When the agent writes data (e.g., `write_inspection`), should writes be:
- **Per-session** — each visit creates a new scoped namespace (`session/{session_id}/inspections`)
- **Append to shared log** — all inspections for a card accumulate under one key

Per-session is cleaner for audit trails. Shared log is simpler for "show me all inspections." Could support both via a `scope` field on the tool definition.

### 2. Card versioning

If someone updates a card, the bridge serves the latest. There is no version pinning or history in v1. The Auki domain's `UpdateData` overwrites. If version history is needed later, it belongs in the platform layer, not the bridge.

### 3. Data population for reads

When the agent calls `read_pressure`, something must have written that data to the domain. In v1, this is out of scope — the data is assumed to exist. In practice, a separate process (edge device, telemetry pipeline, manual upload) writes it. The bridge just reads.

### 4. Rate limiting

The bridge itself has no rate limits in v1. Auki's credit system provides natural throttling. If self-hosted, the operator can add rate limiting at the reverse proxy level.

### 5. Offline / caching

The bridge is stateless and online-only. If the client needs offline access, it should cache the ContextCard locally after first resolve. The bridge does not manage caching.

---

## Tech stack recommendation

- **Language:** Python (FastAPI) — consistent with ship-edge, and `domain-http` has Python bindings
- **Dependencies:** `domain-http` (Auki Python bindings), `fastapi`, `pydantic` (schema validation), `uvicorn`
- **Deployment:** Docker container, single image, configurable via environment variables (domain endpoint, port)
- **Config:** Domain server URL and default credentials via env vars. Per-request auth via headers.

---

## v1 scope

Ship when these work end-to-end:

- [ ] Bridge starts, connects to an Auki domain
- [ ] `GET /resolve/{key}` returns a valid ContextCard from the domain
- [ ] `GET /card/{id}` returns a valid ContextCard
- [ ] `POST /session/{card_id}/data` writes session data to the domain
- [ ] `GET /session/{card_id}/data/{key}` reads session data from the domain
- [ ] Auth pass-through works (caller's Auki credentials used for domain access)
- [ ] Schema validation rejects malformed ContextCards
- [ ] One example ContextCard included in the repo
- [ ] README with setup instructions (local run, Docker, env config)
- [ ] `external` tool type returns 501 Not Implemented
