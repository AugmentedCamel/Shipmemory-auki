# ShipMemory Bridge

Open-source API bridge that resolves QR lookup keys to ContextCards stored on [Auki](https://auki.network) Domains. Any AI agent that scans a QR code can get the context it needs to start a session — system prompt, tools, and execution URL — without knowing anything about Auki.

## How it works

```
┌──────────┐  scan QR   ┌──────────────┐  ?key=xxx   ┌──────────────┐  Auki API  ┌──────────────┐
│  Agent   │ ─────────→ │  QR encodes  │ ──────────→ │    Bridge    │ ─────────→ │ Auki Domain  │
│  (phone) │            │  resolve URL │              │  (this repo) │            │  (storage)   │
└──────────┘            └──────────────┘              └──────────────┘            └──────────────┘
     ↑                                                       │
     └───────────── ContextCard JSON ─────────────────────────┘
```

1. You **deploy a ContextCard** via the web UI or API — the bridge stores it on Auki and generates a QR code
2. The QR encodes a resolve URL: `https://your-bridge.com/resolve/my-card`
3. An **agent app scans** the QR, fetches the URL (appending `?key=`), and receives the ContextCard
4. The card contains `body` (system prompt), `tools`, and optional `execute_url` — everything needed to start a session

## Auth model

| Who | Authenticates how | Against what |
|---|---|---|
| Bridge → Auki | Email/password (env vars, on startup) | Auki Network API (3-tier JWT) |
| Client → Bridge | `?key=` query param on every request | Bridge's `API_KEY` env var |

- **Bridge owns the Auki credentials** — logs in once, caches domain token, auto-refreshes
- **Clients never touch Auki** — they only need the API key
- **Each operator hosts their own bridge** with their own domain and API key
- `.env` is gitignored — credentials are never committed

## ContextCard format

Matches the [shipmemory](https://github.com/) Android client's `ContextCard.kt` exactly:

```json
{
  "body": "You are a field service assistant for the STM Waterjet Premium...",
  "tools": [
    {
      "name": "get_procedure",
      "description": "Get step-by-step maintenance procedure",
      "parameters": {
        "type": "object",
        "properties": {
          "procedure_id": { "type": "string" }
        },
        "required": ["procedure_id"]
      }
    }
  ],
  "execute_url": "https://your-backend.com/api/execute"
}
```

| Field | Required | Description |
|---|---|---|
| `body` | yes | System prompt injected into the agent/voice session |
| `tools` | no | Tool declarations (name, description, JSON Schema parameters) |
| `execute_url` | no | URL the agent POSTs tool calls to |

## Quick start

### 1. Configure

```bash
cp .env.example .env
```

```env
PORT=3000
BRIDGE_BASE_URL=https://your-bridge.up.railway.app   # Public URL — goes into QR codes
API_KEY=your-secret-key

AUKI_EMAIL=your@email.com
AUKI_PASSWORD=your-password
AUKI_DOMAIN_ID=your-domain-id
```

### 2. Run

```bash
bun install
bun run dev
```

```
[BridgeAuth] Logging in as your@email.com...
[BridgeAuth] Ready
ShipMemory Bridge running on port 3000
```

### 3. Deploy a card

**Web UI:** Open `http://localhost:3000/ui`, enter your API key, fill in a card ID + body, hit Deploy. Download the QR code.

**API:**
```bash
curl -X POST "http://localhost:3000/deploy?key=your-secret-key" \
  -H "Content-Type: application/json" \
  -d '{"id": "my-machine", "body": "You are a maintenance assistant for..."}'
```

Returns the card data ID, QR registry ID, QR image (base64), and resolve URL.

### 4. Test resolve

```bash
curl "http://localhost:3000/resolve/my-machine?key=your-secret-key"
```

Returns the ContextCard JSON — exactly what the agent app gets when it scans the QR.

### 5. Scan with an agent

Print or display the QR code. The agent app scans it, fetches the resolve URL, and starts a session with the card's system prompt and tools.

## API

| Method | Path | Description |
|---|---|---|
| `GET` | `/resolve/:key?key=` | QR lookup → ContextCard JSON |
| `GET` | `/card?key=` | List all cards (full content + registry keys) |
| `GET` | `/card/:id?key=` | Fetch single card by data ID |
| `GET` | `/card/:id/tools?key=` | Tools array from a card |
| `POST` | `/deploy?key=` | Deploy card + QR registry + QR image |
| `PUT` | `/deploy/:id?key=` | Update a card's body/tools |
| `DELETE` | `/deploy/:id?key=` | Delete card + registry + QR image |
| `GET` | `/qr/:key?key=` | Get or generate QR code PNG |
| `GET` | `/session/:card_id/data/:key?key=` | Read session data |
| `POST` | `/session/:card_id/data?key=` | Write session data |
| `POST` | `/auth/login` | Proxy Auki login (returns tokens) |
| `GET` | `/health` | Health check |

## How resolve works

```
GET /resolve/my-machine?key=xxx
  │
  ├─ 1. List all qr_registry entries on the domain
  ├─ 2. Find the entry where name === "my-machine"
  ├─ 3. Load registry JSON → get card_id (Auki data ID)
  ├─ 4. Load card by card_id
  ├─ 5. Validate against ContextCard schema
  └─ 6. Return { body, tools?, execute_url? }
```

The QR registry is the single lookup path. The registry `name` must match the card ID in the resolve URL. The `/deploy` endpoint handles this automatically.

## Web UI

The dashboard at `/ui` lets you:

- **Deploy** new cards (card ID + body text → auto-generates QR)
- **View** all cards on the domain with inline QR thumbnails
- **Zoom** into QR codes (click thumbnail → modal with download button)
- **Delete** cards (removes card + registry + QR image from domain)

Auth is a single API key stored in the browser's localStorage.

## Domain data types

| Data type | Purpose | Created by |
|---|---|---|
| `contextcard` | ContextCard JSON | `/deploy` |
| `qr_registry` | Maps key (name) → card data ID | `/deploy` |
| `qr_image` | QR code PNGs (name: `qr_{key}`) | `/deploy`, `/qr` |
| `session:{card_id}:{data_key}` | Per-session scoped tool data | `/session` |

## Deploy to Railway

Includes `Dockerfile` and `railway.toml`. Set env vars in Railway's dashboard:

```bash
railway up
```

For local dev with a mobile agent app, tunnel port 3000:

```bash
ngrok http 3000
```

Set `BRIDGE_BASE_URL` to your ngrok/Railway URL so QR codes resolve correctly.

## License

Apache 2.0
