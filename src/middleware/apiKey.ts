import type { Request, Response, NextFunction } from 'express';
import { BridgeConfig } from '../services/BridgeConfig.js';

/**
 * Validates ?key= query param against the currently configured API key.
 *
 * - If the bridge is unconfigured (no API key set anywhere), returns 503 with
 *   a pointer to /ui so callers know the setup step is required.
 * - If configured, the provided key must match exactly.
 *
 * Config is read per-request from BridgeConfig so changes in Settings take
 * effect immediately — no restart required.
 */
export function requireApiKey(req: Request, res: Response, next: NextFunction) {
  const apiKey = BridgeConfig.current().apiKey;
  if (!apiKey) {
    res.status(503).json({ error: 'Bridge not configured', detail: 'Complete setup at /ui' });
    return;
  }
  const provided = req.query.key as string | undefined;
  if (provided !== apiKey) {
    res.status(401).json({ error: 'Invalid or missing API key' });
    return;
  }
  next();
}
