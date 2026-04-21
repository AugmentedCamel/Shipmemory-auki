import type { DomainAuth } from './AukiAuthService.js';
import { DomainStorageService } from './DomainStorageService.js';
import {
  assetType,
  generateSessionHistoryName,
  isSessionHistoryName,
} from './DomainLayout.js';

type DomainItem = { id?: string; data_id?: string; name?: string };
const idOf = (i: DomainItem) => i.id || i.data_id;

export const MAX_TRANSCRIPT_ENTRIES = 500;

/**
 * Append one session_history entry to the asset folder.
 *
 * The name is self-generated and domain-safe; session_id lives inside the
 * JSON payload only. Chronological order is preserved by the timestamp
 * embedded in the name (fixed-width millis, so lexical sort == time sort).
 */
export async function appendEntry(
  auth: DomainAuth,
  domainId: string,
  assetId: string,
  sessionId: string,
  extra: Record<string, unknown>,
): Promise<{ data_id: string; name: string }> {
  const folder = assetType(assetId);
  const name = generateSessionHistoryName();
  const record = {
    asset_id: assetId,
    session_id: sessionId,
    ...extra,
    created_at: new Date().toISOString(),
  };
  const payload = JSON.stringify(record);
  console.log(
    `[transcript append] data_type="${folder}" name="${name}" name_len=${name.length} payload_bytes=${payload.length}`,
  );

  const dataId = await DomainStorageService.store(auth, domainId, payload, {
    name,
    dataType: folder,
    contentType: 'application/json',
  });

  return { data_id: dataId, name };
}

/**
 * Fetch session_history entries for an asset, optionally filtered by
 * session_id (stored in the payload, not the name). Entries are returned
 * in chronological order, oldest first. `limit` caps the most recent N.
 */
export async function fetchEntries(
  auth: DomainAuth,
  domainId: string,
  assetId: string,
  opts: { sessionId?: string | null; limit?: number } = {},
): Promise<{ entries: any[]; total_available: number }> {
  const folder = assetType(assetId);
  const items = await DomainStorageService.listByType(auth, domainId, folder);

  // Filter by name prefix (cheap), then sort by name (chronological). Loading
  // happens after so we can apply the limit before doing N network calls.
  const candidates = items
    .filter((i: DomainItem) => i.name && isSessionHistoryName(i.name))
    .sort((a: DomainItem, b: DomainItem) => (a.name! < b.name! ? -1 : 1));

  const cap = opts.limit && opts.limit > 0
    ? Math.min(Math.floor(opts.limit), MAX_TRANSCRIPT_ENTRIES)
    : MAX_TRANSCRIPT_ENTRIES;

  // If filtering by session_id we still have to load entries to read the
  // payload. We over-fetch a bit (up to the MAX) so the limit reflects
  // *matching* entries, not total entries.
  const loadWindow = opts.sessionId ? MAX_TRANSCRIPT_ENTRIES : cap;
  const windowed = candidates.length > loadWindow
    ? candidates.slice(-loadWindow)
    : candidates;

  const loaded = await Promise.all(
    windowed.map(async (item: DomainItem) => {
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

  let entries = loaded.filter(Boolean);
  if (opts.sessionId) {
    entries = entries.filter((e: any) => e?.session_id === opts.sessionId);
  }
  const totalAvailable = opts.sessionId ? entries.length : candidates.length;
  if (entries.length > cap) entries = entries.slice(-cap);

  return { entries, total_available: totalAvailable };
}
