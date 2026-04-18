# Tutorial — Build a live voice agent on Auki with ShipMemory

This tutorial walks you from a fresh clone to a live Gemini voice session on Mentra Live smart glasses, triggered by a QR code you generated yourself. By the end you'll have:

- A **ShipMemory Bridge** running on Railway, connected to your own Auki Domain
- A **ContextCard** you authored, stored on that domain, reachable via a QR code
- A **Mentra app** running on Railway that turns the scan into a Gemini Live voice session
- A clear handoff point for replacing the example content with your own

Estimated time: **30–45 minutes** the first time, most of it spent on account signup. The code part is a handful of copy-paste steps.

If you get stuck, the full [README](./README.md) covers each component in reference depth.

---

## What you're building

```
┌────────────────────┐     scan     ┌──────────────────┐   ?key=    ┌────────────────┐   Auki API   ┌──────────────┐
│ Mentra Live        │  ─────────→  │ QR (URL payload) │  ───────→  │  Auki Bridge   │  ─────────→  │ Auki Domain  │
│ (Gemini Live)      │              └──────────────────┘            │  (your deploy) │              │ (your data)  │
└────────────────────┘                                              └────────────────┘              └──────────────┘
```

You control both boxes in the middle. Auki provides the domain (storage). Mentra provides the glasses + platform. Gemini provides the voice model.

---

## Prerequisites

Three accounts — all free tiers are enough for development:

| What you need | Why | Where |
|---|---|---|
| **Auki account + a domain** | Stores ContextCards and QR codes | [auki.network](https://auki.network) |
| **Mentra developer account** | To register your app and install it on your glasses | [docs.mentraglass.com](https://docs.mentraglass.com) |
| **Gemini API key** | Powers the voice model | [aistudio.google.com](https://aistudio.google.com) |

Plus, locally:

- [Bun](https://bun.sh) (or Node 20+)
- `git`, `curl`
- A [Railway](https://railway.app) account for deployment (you can do local-only with ngrok if you prefer — see the Alternative local setup section at the end)
- A pair of **Mentra Live** smart glasses paired to the Mentra app on your phone

---

## Part 1 — Collect your credentials

Before touching code, gather these values. Keep them in a scratch file; you'll paste them into `.env` files in later steps.

### From Auki

1. Sign up at [auki.network](https://auki.network) and verify your email.
2. Create a Domain. Copy the **Domain ID** — it looks like a UUID.
3. Keep the **email + password** you used to sign up. The bridge logs in with these on startup.

| Value | Env var |
|---|---|
| Your Auki login email | `AUKI_EMAIL` |
| Your Auki password | `AUKI_PASSWORD` |
| Your Domain ID | `AUKI_DOMAIN_ID` |

### From Mentra

1. Sign up at the MentraOS developer console (see [docs.mentraglass.com](https://docs.mentraglass.com) for the current URL).
2. Create a new app. Copy the **Package name** (e.g. `com.yourname.shipmemory`) and the **API key**.
3. Install the Mentra app on your phone and pair your Mentra Live glasses.

| Value | Env var |
|---|---|
| Package name | `PACKAGE_NAME` |
| Mentra API key | `MENTRAOS_API_KEY` |

### From Google AI Studio

1. Go to [aistudio.google.com](https://aistudio.google.com) → **Get API key** → **Create API key in new project**.
2. Copy the key.

| Value | Env var |
|---|---|
| Gemini API key | `GEMINI_API_KEY` |

### Pick your own secrets

These you make up. Any random string works — use a password manager.

| Value | Env var | Purpose |
|---|---|---|
| `API_KEY` | `API_KEY` | Bridge's client-auth secret. Any caller to the bridge must pass `?key=<this>` |

---

## Part 2 — Clone and configure

```bash
git clone https://github.com/AugmentedCamel/Shipmemory-auki.git
cd Shipmemory-auki
bun install
```

Create a local `.env` for development:

```bash
cp .env.example .env
```

Open `.env` and fill in everything you collected in Part 1. For now, leave `BRIDGE_BASE_URL` set to `http://localhost:3000` — you'll update it once you deploy.

---

## Part 3 — Run the Bridge locally and deploy a card

This step verifies your Auki credentials work before you push anything to Railway.

```bash
bun run dev
```

You should see:

```
[BridgeAuth] Logging in as you@example.com...
[BridgeAuth] Ready
ShipMemory Bridge running on port 3000
```

If you see `WARN: bridge auth disabled`, one of `AUKI_EMAIL` / `AUKI_PASSWORD` / `AUKI_DOMAIN_ID` is missing. Fix `.env` and restart.

Now deploy your first ContextCard. Open a second terminal:

```bash
curl -X POST "http://localhost:3000/deploy?key=$API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "coffee-machine",
    "body": "You are a voice assistant helping someone operate a Jura E8 espresso machine. Give short, spoken step-by-step instructions. If they ask about anything beyond coffee-making, politely redirect."
  }'
```

You'll get back JSON containing `card_data_id`, `resolve_url`, and a base64 QR image. Ignore the QR for now — the URL inside it still points at `http://localhost:3000`, which your glasses can't reach.

Verify the card resolves:

```bash
curl "http://localhost:3000/resolve/coffee-machine?key=$API_KEY"
```

You should get the ContextCard JSON back. If you do, your Auki side is working. Stop the local server — you're about to deploy to Railway.

---

## Part 4 — Deploy the Bridge to Railway

The Bridge has to be publicly reachable so (a) your glasses can hit `/resolve/...` and (b) QR codes encode a URL that's reachable from anywhere.

1. Create a new Railway project.
2. Add a service from this repo, pointing at the `Dockerfile.bridge` build.
3. In the service's **Variables** tab, set:
   - `PORT=3000`
   - `API_KEY=<your secret>`
   - `AUKI_EMAIL=<...>`
   - `AUKI_PASSWORD=<...>`
   - `AUKI_DOMAIN_ID=<...>`
   - `AUKI_API_BASE_URL=https://api.auki.network`
   - `AUKI_DDS_BASE_URL=https://dds.auki.network`
   - `BRIDGE_BASE_URL=` — **leave blank for now**, we'll fix this after Railway assigns a domain.
4. Generate a public domain in Railway settings. Copy it (e.g. `https://auki-bridge-production.up.railway.app`).
5. Set `BRIDGE_BASE_URL` to that full URL. Railway will redeploy.
6. Check the deploy logs — you should see `[BridgeAuth] Ready`.

Verify the public bridge:

```bash
curl "https://<your-bridge-url>/health"
curl "https://<your-bridge-url>/resolve/coffee-machine?key=<your-api-key>"
```

Both should return JSON. The second returns your ContextCard.

> **Why re-deploy with `BRIDGE_BASE_URL` set:** QR codes encode `{BRIDGE_BASE_URL}/resolve/{id}`. Any cards you deployed while this was wrong have broken QR images stored on the domain. Delete and redeploy them now.

Redeploy the coffee-machine card against the public bridge:

```bash
# Delete the old one (use /ui or find the card_data_id from /card and DELETE it)
# Then redeploy against the Railway URL:
curl -X POST "https://<your-bridge-url>/deploy?key=<your-api-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "coffee-machine",
    "body": "You are a voice assistant helping someone operate a Jura E8 espresso machine..."
  }'
```

Open `https://<your-bridge-url>/ui`, paste your API key, and you'll see the card with a scannable QR code. **Don't scan it yet** — the Mentra app isn't running.

---

## Part 5 — Deploy the Mentra app to Railway

This is the MentraOS app that turns a scan into a voice session.

1. Add a **second service** to the same Railway project, this time pointing at `Dockerfile.client`.
2. Set variables:
   - `PORT=3000`
   - `PACKAGE_NAME=<your Mentra package>`
   - `MENTRAOS_API_KEY=<your Mentra API key>`
   - `GEMINI_API_KEY=<your Gemini key>`
   - `BRIDGE_BASE_URL=<your bridge Railway URL>`
   - `BRIDGE_API_KEY=<same as API_KEY from the bridge>`
3. Generate a public domain for this service too (e.g. `https://shipmemory-mentra-production.up.railway.app`).
4. Check deploy logs — you want to see `Mentra client listening on port 3000`.

### Wire the Mentra console to this URL

In the MentraOS developer console, edit your app:

- **Webhook URL:** `https://<your-mentra-service>.up.railway.app/webhook`
- **Webview URL:** `https://<your-mentra-service>.up.railway.app/webview`

Save. Re-install / refresh the app on your phone so it picks up the new URL.

---

## Part 6 — First voice session on the glasses

1. Put on your Mentra Live glasses. Make sure they're paired to the phone and connected to Wi-Fi.
2. In the MentraOS phone app, launch your app. The glasses should display: *"Open the webview and tap Start"*.
3. On your phone (or laptop), open the webview URL from step 5.
4. You should see **"Ready to start"** and a green **Start** button. Tap it.
5. The glasses' camera stream kicks in. You have ~2 minutes to scan a QR.
6. Point the glasses at the QR code from `/ui`. Say nothing yet.
7. Once the QR is detected and the card resolves, Gemini Live takes over. You'll hear a short pause, then you can start talking.
   - *"How do I make a cappuccino?"*
   - *"What do I do if the milk frother is clogged?"*

The agent answers via MentraOS TTS using the `body` you wrote as its system prompt.

If something breaks, the Railway logs for the Mentra service are the place to look — every stage (`[QR] Scanning`, `[QR] Resolved`, `[Gemini] ...`) logs clearly.

---

## Part 7 — Replace the example with your own content

You've got the loop running. Now the interesting part: making the agent actually useful for *your* use case.

### Simple: just change the prompt

```bash
curl -X PUT "https://<bridge>/deploy/<card_data_id>?key=<api-key>" \
  -H "Content-Type: application/json" \
  -d '{ "body": "Your custom system prompt..." }'
```

Re-scan the same QR. New prompt, same session flow.

### Add tools (function calling)

A ContextCard can declare tools the agent can call during the session. See the [Protocol section of the README](./README.md#1-shipmemory-protocol) for the full schema. Example:

```json
{
  "id": "coffee-machine",
  "body": "You are a voice assistant for a Jura E8 espresso machine...",
  "tools": [
    {
      "name": "log_maintenance_event",
      "description": "Record that the user performed a maintenance step",
      "parameters": {
        "type": "object",
        "properties": {
          "step": { "type": "string" },
          "notes": { "type": "string" }
        },
        "required": ["step"]
      }
    }
  ],
  "execute_url": "https://your-backend.example.com/api/tools"
}
```

When the agent decides to call `log_maintenance_event`, the Mentra app POSTs `{ name, args }` to `execute_url` and returns the response to Gemini. Your backend is where you implement the actual tool.

### Multiple cards for multiple assets

One domain can hold any number of cards. Deploy one per machine / location / task. Each gets its own QR. Scanning switches agents.

---

## Where to go from here

- **Protocol details:** [README §1](./README.md#1-shipmemory-protocol) — exact schema, QR payload formats, allowlist behavior.
- **Bridge API reference:** [README §2](./README.md#2-auki-bridge) — every endpoint, domain data types.
- **Mentra client internals:** [README §3](./README.md#3-mentra-app-gemini-live) — architecture, audio-output workaround, frame pipeline.

---

## Alternative local setup (no Railway)

If you'd rather run everything locally and tunnel with ngrok:

```bash
# Terminal 1 — bridge
bun run dev

# Terminal 2 — tunnel the bridge
ngrok http 3000   # copy the https URL into BRIDGE_BASE_URL in .env, restart bridge

# Terminal 3 — Mentra client on a different port
PORT=3001 bun run dev:client

# Terminal 4 — tunnel the Mentra client
ngrok http 3001   # set this URL as webhook/webview in Mentra console
```

Same flow as Parts 6–7 from there.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `WARN: bridge auth disabled` on bridge startup | Missing `AUKI_*` env vars |
| `/resolve` returns 404 | No card with that key; check `/card` to list all |
| QR scans but nothing happens on glasses | QR URL doesn't match `BRIDGE_BASE_URL` — redeploy the card |
| Mentra app never shows "Ready to start" | Webhook URL wrong in Mentra console, or service is down — check Railway logs |
| Glasses start streaming then stop repeatedly | Mentra `switching_clouds` churn; see [`MENTRA_BUG_REPORT.md`](./MENTRA_BUG_REPORT.md) — the client already has mitigations |
| Gemini connects but never responds | `GEMINI_API_KEY` invalid or out of quota |

Still stuck? File an issue with the relevant section of your Railway logs.
