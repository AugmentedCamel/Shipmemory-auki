import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { BridgeConfig } from '../services/BridgeConfig.js';
import { AukiAuthService, BridgeAuth } from '../services/AukiAuthService.js';
import { requireApiKey } from '../middleware/apiKey.js';

export const setupRoutes = Router();

const MIN_API_KEY_LENGTH = 16;

/**
 * Gate: when the bridge is fully configured, setup endpoints require the
 * current API key (prevents drive-by reconfiguration of a live bridge).
 * When unconfigured, they are open — that's the whole point of the bootstrap.
 */
function setupAuth(req: Request, res: Response, next: NextFunction) {
  if (!BridgeConfig.current().isConfigured) {
    next();
    return;
  }
  requireApiKey(req, res, next);
}

/** GET /api/setup/status — unauthenticated discovery probe. */
setupRoutes.get('/status', (_req, res) => {
  const snapshot = BridgeConfig.current();
  const missing: string[] = [];
  if (!snapshot.aukiEmail) missing.push('aukiEmail');
  if (!snapshot.aukiPassword) missing.push('aukiPassword');
  if (!snapshot.aukiDomainId) missing.push('aukiDomainId');
  if (!snapshot.apiKey) missing.push('apiKey');
  res.json({
    configured: snapshot.isConfigured,
    missing,
    envOverrides: snapshot.envOverrides,
    authReady: BridgeAuth.isReady(),
  });
});

/**
 * POST /api/setup/auki-login
 * Body: { email, password, domainId }
 * Verifies creds against Auki end-to-end (login + mintDomainToken) before
 * persisting. Triggers BridgeAuth re-init via BridgeConfig.onChange.
 */
setupRoutes.post('/auki-login', setupAuth, async (req, res) => {
  try {
    const email = (req.body?.email ?? '').trim();
    const password = (req.body?.password ?? '').trim();
    const domainId = (req.body?.domainId ?? '').trim();

    if (!email || !password || !domainId) {
      res.status(400).json({ error: 'email, password, and domainId are required' });
      return;
    }

    const snapshot = BridgeConfig.current();
    if (snapshot.envOverrides.includes('aukiEmail') ||
        snapshot.envOverrides.includes('aukiPassword') ||
        snapshot.envOverrides.includes('aukiDomainId')) {
      res.status(409).json({ error: 'Auki credentials are set via environment variables — edit them in your hosting dashboard' });
      return;
    }

    // Verify end-to-end before writing anything.
    const { accessToken } = await AukiAuthService.login(email, password);
    await AukiAuthService.mintDomainToken(accessToken, domainId);

    // Persist. BridgeAuth listens for the change and re-inits itself.
    await BridgeConfig.setAuki(email, password, domainId);

    res.json({ ok: true });
  } catch (err: any) {
    const status = err?.response?.status ?? 401;
    const message = err?.response?.data?.error || err?.message || 'Auki login failed';
    res.status(status).json({ error: 'Auki login failed', detail: message });
  }
});

/**
 * POST /api/setup/api-key
 * Body: { apiKey }
 * Sets or rotates the bridge's client-facing API key.
 */
setupRoutes.post('/api-key', setupAuth, async (req, res) => {
  try {
    const apiKey = (req.body?.apiKey ?? '').trim();
    if (!apiKey) {
      res.status(400).json({ error: 'apiKey is required' });
      return;
    }
    if (apiKey.length < MIN_API_KEY_LENGTH) {
      res.status(400).json({ error: `apiKey must be at least ${MIN_API_KEY_LENGTH} characters` });
      return;
    }
    if (BridgeConfig.current().envOverrides.includes('apiKey')) {
      res.status(409).json({ error: 'API key is set via API_KEY env var — edit it in your hosting dashboard' });
      return;
    }
    await BridgeConfig.setApiKey(apiKey);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to set API key', detail: err?.message });
  }
});

/** POST /api/setup/logout — clears Auki creds in config. API key is untouched. */
setupRoutes.post('/logout', setupAuth, async (_req, res) => {
  try {
    const snapshot = BridgeConfig.current();
    const blocked = (['aukiEmail', 'aukiPassword', 'aukiDomainId'] as const).filter((f) =>
      snapshot.envOverrides.includes(f),
    );
    if (blocked.length > 0) {
      res.status(409).json({
        error: 'Cannot logout — Auki credentials are set via environment variables',
        detail: `Unset ${blocked.join(', ')} in your hosting dashboard`,
      });
      return;
    }
    await BridgeConfig.clearAuki();
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: 'Logout failed', detail: err?.message });
  }
});

/**
 * GET /api/setup/config — authed config dump for the Settings view.
 * Password is never returned.
 */
setupRoutes.get('/config', setupAuth, (_req, res) => {
  const snapshot = BridgeConfig.current();
  res.json({
    aukiEmail: snapshot.aukiEmail,
    aukiDomainId: snapshot.aukiDomainId,
    apiKey: snapshot.apiKey,
    envOverrides: snapshot.envOverrides,
    authReady: BridgeAuth.isReady(),
  });
});
