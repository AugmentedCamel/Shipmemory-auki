import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { resolveRoutes } from './routes/resolve.js';
import { cardRoutes } from './routes/card.js';
import { sessionRoutes } from './routes/session.js';
import { qrRoutes } from './routes/qr.js';
import { authRoutes } from './routes/auth.js';
import { deployRoutes } from './routes/deploy.js';
import { inventoryRoutes } from './routes/inventory.js';
import { setupRoutes } from './routes/setup.js';
import { toolRoutes } from './routes/tool.js';
import { toolsRoutes } from './routes/tools.js';
import { uiRoutes } from './routes/ui.js';
import { BridgeAuth } from './services/AukiAuthService.js';
import { BridgeConfig } from './services/BridgeConfig.js';
import { ToolLibrary } from './services/ToolLibrary.js';
import { requireConfigured } from './middleware/requireConfigured.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// Setup endpoints — conditionally authenticated (open when unconfigured)
app.use('/api/setup', setupRoutes);

// Business endpoints — require the bridge to be fully configured + Auki-authed
app.use('/auth', requireConfigured, authRoutes);
app.use('/resolve', requireConfigured, resolveRoutes);
app.use('/card', requireConfigured, cardRoutes);
app.use('/session', requireConfigured, sessionRoutes);
app.use('/qr', requireConfigured, qrRoutes);
app.use('/deploy', requireConfigured, deployRoutes);
app.use('/inventory', requireConfigured, inventoryRoutes);
app.use('/tool', requireConfigured, toolRoutes);
app.use('/api/tools', requireConfigured, toolsRoutes);

// Web UI
app.use('/', uiRoutes);

async function start() {
  await BridgeConfig.load();

  try {
    await BridgeAuth.init();
  } catch (err: any) {
    console.error('[startup] Initial Auki login failed:', err?.message ?? err);
    console.error('[startup] Business endpoints will return 503 until credentials are valid — visit /ui');
  }

  // Best-effort: seed built-in tool presets onto the domain so operators can
  // see the protocol's canonical tool definitions. Skipped silently when auth
  // isn't ready (e.g. first-boot unconfigured state); retried after the setup
  // wizard completes via the BridgeConfig.onChange hook below.
  try {
    await ToolLibrary.seed();
  } catch (err: any) {
    console.warn('[startup] Tool library seed skipped:', err?.message);
  }
  BridgeConfig.onChange(() => {
    // BridgeAuth's own onChange listener runs async — give it a moment to
    // complete before we attempt the seed. seed() is idempotent and guards
    // on auth readiness, so a no-op is fine if we're still too early.
    setTimeout(() => {
      ToolLibrary.seed().catch((err) => console.warn('[config change] seed failed:', err?.message));
    }, 2000);
  });

  if (!BridgeConfig.current().isConfigured) {
    console.log('[Bridge] Unconfigured — complete setup at http://localhost:' + PORT + '/ui');
  }

  app.listen(PORT, () => {
    console.log(`ShipMemory Bridge running on port ${PORT}`);
  });
}

start();
