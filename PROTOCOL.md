# ShipMemory Protocol

A small HTTP protocol for resolving a QR code to a **ContextCard** — a JSON document that tells a live voice agent what to be, what tools it can call, and where to call them. The bridge in this repo is one implementation; the protocol is intentionally minimal so any client or server can speak it.

---

## 1. The ContextCard

When a client GETs `/resolve/<key>?key=<api_key>`, it receives:

```json
{
  "body": "You are the assistant for the Acme-9000 coffee machine. Be concise.",
  "tools": [ /* optional tool definitions — see §2 */ ],
  "execute_url": "https://bridge.example.com/tool/<asset_id>",
  "asset_id": "e2a464cc-8c31-4f33-8bf1-63f742a49024"
}
```

| Field         | Required | Purpose                                                                 |
|---------------|----------|-------------------------------------------------------------------------|
| `body`        | Yes      | System prompt the agent runs with. Non-empty string.                    |
| `tools`       | No       | Zero or more tool definitions (§2).                                     |
| `execute_url` | No       | Single HTTP endpoint the client POSTs tool calls to (§3).               |
| `asset_id`    | No       | Server-assigned ID for this card's storage folder (present when served from the ShipMemory bridge). |

A client can resolve, read `body` and any `tools`, and run a session with no further server contact if the card has no tools. `execute_url` only matters when tools are present.

---

## 2. Tool definition

Each entry in `tools` describes one function the agent can call. The shape matches what Gemini Live (and most function-calling APIs) expect:

```json
{
  "name": "session_history",
  "description": "Save or recall the running log of this session. Call with action='append' after every meaningful exchange.",
  "parameters": {
    "type": "object",
    "properties": {
      "action":     { "type": "string", "enum": ["append", "read"] },
      "session_id": { "type": "string" },
      "question":   { "type": "string" },
      "response":   { "type": "string" },
      "notes":      { "type": "string" },
      "limit":      { "type": "integer" }
    },
    "required": ["action"]
  }
}
```

| Field         | Required | Purpose                                                        |
|---------------|----------|----------------------------------------------------------------|
| `name`        | Yes      | Function name the agent calls. `[a-zA-Z0-9_.-]+`.              |
| `description` | No       | Short text the agent uses to decide when to call.              |
| `parameters`  | No       | JSON Schema object describing arguments.                       |

Tools don't carry their own URL. All calls go to the card's single `execute_url` (§3) and the server dispatches by `name`.

---

## 3. Tool execution (the dispatcher contract)

A tool call is one HTTP POST. The client takes the function call the agent emitted and forwards it verbatim:

```
POST <execute_url>?key=<api_key>
Content-Type: application/json

{
  "tool":   "session_history",
  "params": { "action": "append", "session_id": "s_42", "question": "how hot?", "response": "60C" }
}
```

The server routes by `tool` name. Response:

```json
{ "ok": true, "data_id": "...", "turn": 3 }
```

Errors return a non-2xx status with `{ "error": "...", "detail": "..." }`. The client feeds the result back to the agent as the tool-response event.

The bridge in this repo implements one built-in tool at this endpoint (`session_history`) and 404s on unknown tool names. Operators running custom tools point a card's `execute_url` at **their own** server speaking this same contract.

---

## 4. QR payload

The QR code encodes the resolve URL:

```
https://<bridge>/resolve/<key>
```

When a client scans a QR whose payload starts with `https://`, it appends `?key=<api_key>` and GETs. The response is a ContextCard (§1). That's the entire handshake.

Non-URL payloads (plain text, SM1) are implementation-defined and outside this protocol.

---

## 5. Where data lives (bridge implementation note)

The bridge stores each card as an **asset folder** on an Auki Domain. One folder per card, identified by a fresh `asset_id` (UUID) at deploy time. Inside:

- **Card file** — the ContextCard JSON
- **QR file** — the PNG
- **Session transcript** — one file per turn, written by the `session_history` tool

A small `registry` entry maps the human-friendly QR key to the folder's `asset_id`. The agent never sees this split — it receives an expanded ContextCard from `/resolve`. This section is documentation for custom-server implementers, not protocol.

---

## 6. Building a custom tool

To add a tool beyond the built-ins, define its `{ name, description, parameters }` and decide what server will execute it:

- **Run on the bridge** — save the preset via `POST /api/tools` and include a `builtin` marker **only if the bridge has a handler for it** (today: just `session_history`). Don't invent builtin names.
- **Run on your own server** — set `execute_url` on the preset to your server, or set it at the card level. Your server accepts POST bodies shaped as in §3, routes by `tool`, and returns `{ ok, ...result }`.

Attach the tool to a card by saving its `name` into the card's `tool_refs` array. The bridge expands the ref at `/resolve` time into the full tool definition the agent needs.

A suggested prompt for Claude Code when building a tool from scratch:

> Build me a ShipMemory tool following the protocol at
> https://github.com/AugmentedCamel/Shipmemory-auki/blob/main/PROTOCOL.md.
> It should <what the tool does>. Parameters: <fields and types>. It will
> be called at <my server URL> using the POST `{ tool, params }` contract
> from §3. Return just the preset JSON with `name`, `description`,
> `parameters`, and `execute_url` — I'll paste it into the bridge UI.
