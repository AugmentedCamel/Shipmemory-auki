import type { ContextCard, ContextProvider, Frame } from './types.js';
import { decodeQR } from './qrDecoder.js';
import { decodeSM1 } from './sm1.js';
import { fetchContextCard, parseContextCardJSON } from './urlFetch.js';

/**
 * Real ShipMemory context provider.
 * Scans frames for QR codes → decodes SM1 or URL → returns ContextCard.
 */
export class ShipMemoryService implements ContextProvider {
  constructor(private apiKey?: string | null) {}

  async scan(frames: AsyncIterable<Frame>): Promise<ContextCard> {
    console.log('[ShipMemory] Scanning for QR codes…');

    for await (const frame of frames) {
      const raw = decodeQR(frame);
      if (!raw) continue;

      console.log(`[ShipMemory] QR detected: ${raw.slice(0, 80)}…`);
      return this.resolve(raw);
    }

    throw new Error('Frame stream ended without finding a QR code');
  }

  private async resolve(raw: string): Promise<ContextCard> {
    // SM1-encoded inline data
    const decoded = decodeSM1(raw);

    // If it's a URL, fetch the card from the bridge
    if (decoded.startsWith('https://')) {
      console.log(`[ShipMemory] Fetching card from URL: ${decoded.slice(0, 80)}`);
      return fetchContextCard(decoded, this.apiKey);
    }

    // Try parsing as JSON (inline structured card)
    try {
      const json = JSON.parse(decoded);
      return parseContextCardJSON(json);
    } catch {
      // Plain text — use as body directly
      return {
        body: decoded,
        tools: [],
        execute_url: null,
        session_id: null,
        trace_url: null,
      };
    }
  }
}
