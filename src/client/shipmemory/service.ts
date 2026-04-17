import { createHash } from 'crypto';
import type { ContextCard, ContextProvider, Frame } from './types.js';
import { decodeQR } from './qrDecoder.js';
import { decodeSM1 } from './sm1.js';
import { fetchContextCard, parseContextCardJSON } from './urlFetch.js';
import { isAllowed, allowedPrefixes } from './allowlist.js';

const CONSENSUS_REQUIRED = 2;

/**
 * Real ShipMemory context provider.
 * Scans frames for QR codes → requires 2-frame consensus → decodes → resolves.
 */
export class ShipMemoryService implements ContextProvider {
  constructor(private apiKey?: string | null) {}

  async scan(frames: AsyncIterable<Frame>): Promise<ContextCard> {
    console.log(`[QR] Scanning (allowlist: ${allowedPrefixes().join(', ') || '<empty>'})`);

    let lastRaw: string | null = null;
    let streak = 0;

    for await (const frame of frames) {
      const raw = decodeQR(frame);
      if (!raw) continue;

      const hash = sha1Prefix(raw);
      console.log(`[QR] Decoded (${hash}): "${truncate(raw, 200)}"`);

      if (raw === lastRaw) {
        streak++;
      } else {
        lastRaw = raw;
        streak = 1;
      }

      if (streak < CONSENSUS_REQUIRED) {
        console.log(`[QR] Consensus ${streak}/${CONSENSUS_REQUIRED}: ${hash}`);
        continue;
      }

      console.log(`[QR] Consensus ${streak}/${CONSENSUS_REQUIRED}: committing ${hash}`);
      try {
        const card = await this.resolve(raw);
        console.log(
          `[QR] Resolved → body="${truncate(card.body, 60)}", tools=${card.tools.length}, ` +
          `execute_url=${originOrNull(card.execute_url)}, trace_url=${originOrNull(card.trace_url)}`,
        );
        return card;
      } catch (err) {
        console.warn(`[QR] Error: ${err instanceof Error ? err.message : String(err)}`);
        // Reset consensus and keep scanning
        lastRaw = null;
        streak = 0;
      }
    }

    throw new Error('Frame stream ended without finding a QR code');
  }

  private async resolve(raw: string): Promise<ContextCard> {
    const decoded = decodeSM1(raw);

    // URL payload: fetch card from bridge (allowlist enforced inside fetchContextCard)
    if (decoded.startsWith('https://')) {
      console.log(`[QR] Fetching card from URL: ${decoded.slice(0, 120)}`);
      const card = await fetchContextCard(decoded, this.apiKey);
      return sanitizeCardUrls(card);
    }

    // Inline JSON card
    try {
      const json = JSON.parse(decoded);
      return sanitizeCardUrls(parseContextCardJSON(json));
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

/** Null out execute_url/trace_url that fail the allowlist — keep the rest of the card usable. */
function sanitizeCardUrls(card: ContextCard): ContextCard {
  let execute_url = card.execute_url;
  let trace_url = card.trace_url;

  if (execute_url && !isAllowed(execute_url)) {
    console.warn(`[QR] Rejected execute_url: ${execute_url} — not in allowlist`);
    execute_url = null;
  }
  if (trace_url && !isAllowed(trace_url)) {
    console.warn(`[QR] Rejected trace_url: ${trace_url} — not in allowlist`);
    trace_url = null;
  }

  return { ...card, execute_url, trace_url };
}

function sha1Prefix(s: string): string {
  return createHash('sha1').update(s).digest('hex').slice(0, 8);
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function originOrNull(url: string | null): string {
  if (!url) return 'null';
  try {
    return new URL(url).origin;
  } catch {
    return 'invalid';
  }
}
