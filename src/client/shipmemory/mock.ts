import type { ContextCard, ContextProvider, Frame } from './types.js';

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
