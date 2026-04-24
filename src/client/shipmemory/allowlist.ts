import { env } from '../config/env.js';

/**
 * Parse the configured allowlist once. Sources:
 *   - ALLOWED_URL_PREFIXES (comma-separated, preferred)
 *   - BRIDGE_BASE_URL + SHIP_EDGE_BASE_URL (fallback defaults for our stack)
 * Empty list means NOTHING is allowed.
 */
function buildPrefixes(): string[] {
  const raw = env.ALLOWED_URL_PREFIXES;
  if (raw) {
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
  }
  const defaults: string[] = [];
  if (env.BRIDGE_BASE_URL) defaults.push(env.BRIDGE_BASE_URL);
  if (env.SHIP_EDGE_BASE_URL) defaults.push(env.SHIP_EDGE_BASE_URL);
  return defaults;
}

const PREFIXES = buildPrefixes();

export function isAllowed(url: string): boolean {
  if (PREFIXES.length === 0) return false;
  return PREFIXES.some((p) => url.startsWith(p));
}

export function allowedPrefixes(): readonly string[] {
  return PREFIXES;
}
