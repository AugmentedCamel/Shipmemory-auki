import type { DomainAuth } from './AukiAuthService.js';
import { DomainStorageService } from './DomainStorageService.js';
import { assetType, parseSessionName, sessionName } from './DomainLayout.js';

type DomainItem = { id?: string; data_id?: string; name?: string };
const idOf = (i: DomainItem) => i.id || i.data_id;

export const MAX_TRANSCRIPT_ENTRIES = 500;

/**
 * Append one transcript entry to the asset folder. Turn index auto-increments
 * from existing entries for the given session_id. The `extra` object is merged
 * into the stored record verbatim — different callers (role-based transcript
 * route vs. session_history tool) store different shapes; readers are expected
 * to handle that.
 */
export async function appendEntry(
  auth: DomainAuth,
  domainId: string,
  assetId: string,
  sessionId: string,
  extra: Record<string, unknown>,
): Promise<{ data_id: string; turn: number; name: string }> {
  const folder = assetType(assetId);
  const items = await DomainStorageService.listByType(auth, domainId, folder);

  let nextTurn = 0;
  for (const item of items) {
    if (!item.name) continue;
    const parsed = parseSessionName(item.name);
    if (parsed && parsed.sessionId === sessionId) {
      nextTurn = Math.max(nextTurn, parsed.turn + 1);
    }
  }

  const record = {
    asset_id: assetId,
    session_id: sessionId,
    turn: nextTurn,
    ...extra,
    created_at: new Date().toISOString(),
  };
  const name = sessionName(sessionId, nextTurn);

  const dataId = await DomainStorageService.store(auth, domainId, JSON.stringify(record), {
    name,
    dataType: folder,
    contentType: 'application/json',
  });

  return { data_id: dataId, turn: nextTurn, name };
}

/**
 * Fetch transcript entries for an asset. Without session_id, returns across
 * all sessions (ordered by session then turn). `limit` caps the number of
 * entries returned (most recent wins when the cap bites).
 */
export async function fetchEntries(
  auth: DomainAuth,
  domainId: string,
  assetId: string,
  opts: { sessionId?: string | null; limit?: number } = {},
): Promise<{ entries: any[]; total_available: number }> {
  const folder = assetType(assetId);
  const items = await DomainStorageService.listByType(auth, domainId, folder);

  const matches: { item: DomainItem; sessionId: string; turn: number }[] = [];
  for (const item of items) {
    if (!item.name) continue;
    const parsed = parseSessionName(item.name);
    if (!parsed) continue;
    if (opts.sessionId && parsed.sessionId !== opts.sessionId) continue;
    matches.push({ item, sessionId: parsed.sessionId, turn: parsed.turn });
  }

  matches.sort((a, b) => {
    if (a.sessionId !== b.sessionId) return a.sessionId < b.sessionId ? -1 : 1;
    return a.turn - b.turn;
  });

  const cap = opts.limit && opts.limit > 0
    ? Math.min(Math.floor(opts.limit), MAX_TRANSCRIPT_ENTRIES)
    : MAX_TRANSCRIPT_ENTRIES;
  const windowed = matches.length > cap ? matches.slice(-cap) : matches;

  const entries = await Promise.all(
    windowed.map(async ({ item }) => {
      const id = idOf(item);
      if (!id) return null;
      try {
        const raw = await DomainStorageService.load(auth, domainId, id);
        return JSON.parse(raw.buffer.toString('utf-8'));
      } catch {
        return null;
      }
    }),
  );

  return {
    entries: entries.filter(Boolean),
    total_available: matches.length,
  };
}
