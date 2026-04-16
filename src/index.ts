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
import { uiRoutes } from './routes/ui.js';
import { BridgeAuth } from './services/AukiAuthService.js';

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

// API routes
app.use('/auth', authRoutes);
app.use('/resolve', resolveRoutes);        // Public: uses ?key= and bridge's own domain token
app.use('/card', cardRoutes);              // Authenticated: requires Authorization header
app.use('/session', sessionRoutes);        // Authenticated: requires Authorization header
app.use('/qr', qrRoutes);                 // Authenticated: requires Authorization header
app.use('/deploy', deployRoutes);          // Authenticated: requires Authorization header

// Web UI
app.use('/', uiRoutes);

async function start() {
  try {
    await BridgeAuth.init();
  } catch (err: any) {
    console.error('[startup] Bridge auth failed:', err.message);
    console.error('[startup] Public endpoints (/resolve) will not work until auth is configured');
  }
  app.listen(PORT, () => {
    console.log(`ShipMemory Bridge running on port ${PORT}`);
  });
}

start();
