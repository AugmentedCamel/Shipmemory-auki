import type { Request, Response, NextFunction } from 'express';
import { BridgeAuth } from '../services/AukiAuthService.js';
import { BridgeConfig } from '../services/BridgeConfig.js';

/**
 * Guard for business endpoints that need a live Auki domain token.
 * Returns 503 if the bridge is unconfigured. If configured but not yet
 * authenticated (e.g. startup login raced/failed), lazily re-runs the login
 * flow so a valid API key request transparently recovers.
 */
export async function requireConfigured(_req: Request, res: Response, next: NextFunction) {
  if (!BridgeConfig.current().isConfigured) {
    res.status(503).json({ error: 'Bridge not configured', detail: 'Complete setup at /ui' });
    return;
  }
  if (!BridgeAuth.isReady()) {
    try {
      await BridgeAuth.ensureReady();
    } catch (err: any) {
      res.status(503).json({ error: 'Bridge auth not ready', detail: err?.message ?? 'Auki login failed' });
      return;
    }
  }
  next();
}
