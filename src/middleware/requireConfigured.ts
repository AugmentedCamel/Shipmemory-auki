import type { Request, Response, NextFunction } from 'express';
import { BridgeAuth } from '../services/AukiAuthService.js';
import { BridgeConfig } from '../services/BridgeConfig.js';

/**
 * Guard for business endpoints that need a live Auki domain token.
 * Returns 503 if the bridge is unconfigured or the domain auth isn't ready yet.
 */
export function requireConfigured(_req: Request, res: Response, next: NextFunction) {
  if (!BridgeConfig.current().isConfigured) {
    res.status(503).json({ error: 'Bridge not configured', detail: 'Complete setup at /ui' });
    return;
  }
  if (!BridgeAuth.isReady()) {
    res.status(503).json({ error: 'Bridge auth not ready', detail: 'Auki login has not completed — try again shortly' });
    return;
  }
  next();
}
