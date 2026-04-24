function required(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`${name} is not set in .env file`);
  return val;
}

export const env = {
  PACKAGE_NAME: required('PACKAGE_NAME'),
  MENTRAOS_API_KEY: required('MENTRAOS_API_KEY'),
  GEMINI_API_KEY: required('GEMINI_API_KEY'),
  PORT: parseInt(process.env.PORT || '3000'),

  /** ShipMemory bridge URL for resolving context cards (optional — use mock if unset) */
  BRIDGE_BASE_URL: process.env.BRIDGE_BASE_URL ?? null,
  /** API key for the ShipMemory bridge (optional) */
  BRIDGE_API_KEY: process.env.BRIDGE_API_KEY ?? null,
  /** Hardcoded resolve URL — skips QR scanning, fetches card directly (e.g. https://bridge.example/resolve/my-card) */
  CONTEXT_CARD_URL: process.env.CONTEXT_CARD_URL ?? null,
  /** Comma-separated URL prefixes allowed for QR payload / card.execute_url / card.trace_url. Defaults to BRIDGE_BASE_URL. */
  ALLOWED_URL_PREFIXES: process.env.ALLOWED_URL_PREFIXES ?? null,
  /**
   * Oneshot-specific: redirect base for `oneshot.glass/c/{code}` short URLs.
   * NOT part of the ShipMemory Protocol — this is a custom client-side shim
   * that rewrites our browser-facing landing host to our JSON edge service.
   * Other implementers of the protocol should NOT copy this; they'd point to
   * their own edge host (or skip the rewrite entirely).
   */
  SHIP_EDGE_BASE_URL: process.env.SHIP_EDGE_BASE_URL ?? 'https://shipedge-production.up.railway.app',
} as const;
