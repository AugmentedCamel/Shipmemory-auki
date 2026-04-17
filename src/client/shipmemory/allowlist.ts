import { env } from '../config/env.js';

/**
 * Parse the configured allowlist once. Sources:
 *   - ALLOWED_URL_PREFIXES (comma-separated, preferred)
 *   - BRIDGE_BASE_URL (fallback — trust our own bridge by default)
 * Empty list means NOTHING is allowed.
 */
function buildPrefixes(): string[] {
  const raw = env.ALLOWED_URL_PREFIXES;
  if (raw) {
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return env.BRIDGE_BASE_URL ? [env.BRIDGE_BASE_URL] : [];
}

const PREFIXES = buildPrefixes();

export function isAllowed(url: string): boolean {
  if (PREFIXES.length === 0) return false;
  return PREFIXES.some((p) => url.startsWith(p));
}

export function allowedPrefixes(): readonly string[] {
  return PREFIXES;
}
