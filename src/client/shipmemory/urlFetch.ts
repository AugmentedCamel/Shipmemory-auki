import type { ContextCard, ToolDeclaration } from './types.js';
import { isAllowed, allowedPrefixes } from './allowlist.js';

const MAX_RESPONSE_SIZE = 100_000;

/**
 * Fetch a ContextCard from a URL (the QR contained a URL, not inline data).
 * Appends ?key= if an API key is provided. URL must pass the allowlist.
 */
export async function fetchContextCard(
  url: string,
  apiKey?: string | null,
): Promise<ContextCard> {
  if (!isAllowed(url)) {
    console.warn(`[QR] Rejected URL: ${url} — not in allowlist (${allowedPrefixes().join(', ') || '<empty>'})`);
    throw new Error(`URL not in allowlist: ${url}`);
  }

  const target = new URL(url);
  if (apiKey) target.searchParams.set('key', apiKey);

  const res = await fetch(target.toString(), {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    throw new Error(`ContextCard fetch failed: ${res.status} ${res.statusText}`);
  }

  const text = await res.text();
  if (text.length > MAX_RESPONSE_SIZE) {
    throw new Error(`ContextCard response too large: ${text.length} chars`);
  }

  return parseContextCardJSON(JSON.parse(text));
}

export function parseContextCardJSON(json: Record<string, unknown>): ContextCard {
  const body = json.body;
  if (typeof body !== 'string' || !body.trim()) {
    throw new Error('ContextCard missing required non-empty "body" field');
  }

  const tools: ToolDeclaration[] = [];
  if (Array.isArray(json.tools)) {
    for (const t of json.tools) {
      if (t && typeof t.name === 'string' && typeof t.description === 'string') {
        tools.push({
          name: t.name,
          description: t.description,
          parameters: (t.parameters as Record<string, unknown>) ?? {},
        });
      }
    }
  }

  return {
    body,
    tools,
    execute_url: typeof json.execute_url === 'string' ? json.execute_url : null,
    session_id: typeof json.session_id === 'string' ? json.session_id : null,
    trace_url: typeof json.trace_url === 'string' ? json.trace_url : null,
  };
}
