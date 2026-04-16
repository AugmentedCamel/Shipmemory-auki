import type { Request, Response, NextFunction } from 'express';

const API_KEY = process.env.API_KEY || '';

/**
 * Validates ?key= query param against the configured API_KEY.
 * If no API_KEY is set in env, all requests pass through.
 */
export function requireApiKey(req: Request, res: Response, next: NextFunction) {
  if (!API_KEY) {
    next();
    return;
  }
  const key = req.query.key as string | undefined;
  if (key !== API_KEY) {
    res.status(401).json({ error: 'Invalid or missing API key' });
    return;
  }
  next();
}
