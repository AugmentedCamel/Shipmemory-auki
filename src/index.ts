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
import { setupRoutes } from './routes/setup.js';
import { uiRoutes } from './routes/ui.js';
import { BridgeAuth } from './services/AukiAuthService.js';
import { BridgeConfig } from './services/BridgeConfig.js';
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

  if (!BridgeConfig.current().isConfigured) {
    console.log('[Bridge] Unconfigured — complete setup at http://localhost:' + PORT + '/ui');
  }

  app.listen(PORT, () => {
    console.log(`ShipMemory Bridge running on port ${PORT}`);
  });
}

start();
