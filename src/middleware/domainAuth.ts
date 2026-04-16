import type { Request, Response, NextFunction } from 'express';
import { AukiAuthService, type DomainAuth } from '../services/AukiAuthService.js';

/**
 * Middleware that extracts session token + domain ID from request headers,
 * mints a domain token, and attaches it to req.domainAuth.
 *
 * Required headers:
 *   Authorization: Bearer <auki-session-token>
 *   x-domain-id: <domain-id>  (or falls back to AUKI_DEFAULT_DOMAIN_ID)
 */
export async function requireDomainAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing Authorization header' });
      return;
    }
    const sessionToken = authHeader.slice(7);
    const domainId = (req.headers['x-domain-id'] as string) || process.env.AUKI_DEFAULT_DOMAIN_ID;
    if (!domainId) {
      res.status(400).json({ error: 'Missing x-domain-id header and no default configured' });
      return;
    }

    const domainAuth = await AukiAuthService.mintDomainToken(sessionToken, domainId);
    (req as any).domainAuth = domainAuth;
    (req as any).domainId = domainId;
    next();
  } catch (err: any) {
    const status = err?.response?.status || 401;
    res.status(status).json({ error: 'Domain auth failed', detail: err?.message });
  }
}

/** Type helper for routes behind requireDomainAuth */
export interface AuthenticatedRequest extends Request {
  domainAuth: DomainAuth;
  domainId: string;
}
