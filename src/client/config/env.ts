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
} as const;
