import type { ContextCard, ContextProvider, Frame } from './types.js';
import { fetchContextCard } from './urlFetch.js';

const MOCK_CARD: ContextCard = {
  body: `You are a helpful voice assistant running on smart glasses.
The user is testing the system. Respond naturally to their questions.
Keep answers short and conversational — they're hearing you through speakers, not reading.`,
  tools: [],
  execute_url: null,
  session_id: 'mock-session',
  trace_url: null,
};

/**
 * Returns a static ContextCard after a brief delay.
 * Proves the base app works without real QR scanning.
 */
export class MockShipMemoryService implements ContextProvider {
  async scan(_frames: AsyncIterable<Frame>): Promise<ContextCard> {
    console.log('[ShipMemory:mock] Returning mock card in 1s…');
    await new Promise((r) => setTimeout(r, 1000));
    return MOCK_CARD;
  }
}

/**
 * Skips QR scanning — fetches a ContextCard directly from a hardcoded resolve URL.
 * Use this to test the real ShipMemory protocol without camera/QR infrastructure.
 *
 * Example URL: https://your-bridge.up.railway.app/resolve/my-card-id
 */
export class HardcodedUrlProvider implements ContextProvider {
  constructor(
    private resolveUrl: string,
    private apiKey?: string | null,
  ) {}

  async scan(_frames: AsyncIterable<Frame>): Promise<ContextCard> {
    console.log(`[ShipMemory:hardcoded] Fetching card from ${this.resolveUrl}`);
    const card = await fetchContextCard(this.resolveUrl, this.apiKey);
    console.log(`[ShipMemory:hardcoded] Got card: ${card.body.slice(0, 80)}…`);
    return card;
  }
}
