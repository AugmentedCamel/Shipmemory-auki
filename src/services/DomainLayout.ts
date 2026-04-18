import type { DomainAuth } from './AukiAuthService.js';
import { DomainStorageService } from './DomainStorageService.js';

/**
 * Asset-folder layout on the Auki domain.
 *
 * Two top-level data_types:
 *   - REGISTRY_TYPE     One entry per QR key. `name = <QR key>`, body `{ asset_id, key }`.
 *   - `asset:<asset_id>` Everything that belongs to one card. Entries differentiated by `name`:
 *       name="card"                       → ContextCard JSON
 *       name="qr"                         → QR PNG
 *       name="session:<sid>:<turn>"       → transcript entry (append-only)
 *
 * Registries are the only thing the resolver lists; once we have the asset_id
 * a single listByType gets every file belonging to that card.
 *
 * Legacy layout (kept for read-only fallback):
 *   - `qr_registry`  name=<key>  body `{ card_id, key }`
 *   - `contextcard`  free-standing card entries
 *   - `qr_image`     name=`qr_<key>`
 *   - `session:<card_id>:<data_key>`  per-(card,key) buckets
 */

export const REGISTRY_TYPE = 'registry';
export const NAME_CARD = 'card';
export const NAME_QR = 'qr';

export function assetType(assetId: string): string {
  return `asset:${assetId}`;
}

export function sessionName(sessionId: string, turn: number): string {
  // Zero-pad so lexical sort == chronological sort in listByType output.
  return `session:${sessionId}:${String(turn).padStart(6, '0')}`;
}

export function parseSessionName(name: string): { sessionId: string; turn: number } | null {
  const m = /^session:([^:]+):(\d+)$/.exec(name);
  if (!m) return null;
  return { sessionId: m[1], turn: parseInt(m[2], 10) };
}

type DomainItem = { id?: string; data_id?: string; name?: string; [k: string]: unknown };
function idOf(item: DomainItem): string | undefined {
  return item.id || item.data_id;
}

export type RegistryRecord = {
  asset_id: string;
  key: string;
};

export type LegacyRegistryRecord = {
  card_id: string;
  key: string;
};

export type ResolvedKey =
  | { via: 'registry'; key: string; asset_id: string; registry_data_id: string }
  | { via: 'legacy'; key: string; card_id: string; registry_data_id: string };

/**
 * Look up a QR key across both layouts. New layout wins. Returns null if
 * neither layout has it.
 */
export async function resolveKey(
  auth: DomainAuth,
  domainId: string,
  key: string,
): Promise<ResolvedKey | null> {
  const modern = await DomainStorageService.listByType(auth, domainId, REGISTRY_TYPE);
  const modernHit = modern.find((e: DomainItem) => e.name === key);
  if (modernHit) {
    const id = idOf(modernHit);
    if (id) {
      try {
        const raw = await DomainStorageService.load(auth, domainId, id);
        const parsed = JSON.parse(raw.buffer.toString('utf-8')) as Partial<RegistryRecord>;
        if (parsed.asset_id) {
          return { via: 'registry', key, asset_id: parsed.asset_id, registry_data_id: id };
        }
      } catch {
        // fall through to legacy lookup
      }
    }
  }

  const legacy = await DomainStorageService.listByType(auth, domainId, 'qr_registry');
  const legacyHit = legacy.find((e: DomainItem) => e.name === key);
  if (legacyHit) {
    const id = idOf(legacyHit);
    if (id) {
      try {
        const raw = await DomainStorageService.load(auth, domainId, id);
        const parsed = JSON.parse(raw.buffer.toString('utf-8')) as Partial<LegacyRegistryRecord>;
        if (parsed.card_id) {
          return { via: 'legacy', key, card_id: parsed.card_id, registry_data_id: id };
        }
      } catch {
        return null;
      }
    }
  }

  return null;
}

/** Load the card that belongs to a resolved key. Returns the raw parsed JSON. */
export async function loadCardForResolved(
  auth: DomainAuth,
  domainId: string,
  resolved: ResolvedKey,
): Promise<{ card: unknown; card_data_id: string } | null> {
  if (resolved.via === 'registry') {
    const items = await DomainStorageService.listByType(auth, domainId, assetType(resolved.asset_id));
    const entry = items.find((i: DomainItem) => i.name === NAME_CARD);
    const id = entry ? idOf(entry) : undefined;
    if (!id) return null;
    const raw = await DomainStorageService.load(auth, domainId, id);
    return { card: JSON.parse(raw.buffer.toString('utf-8')), card_data_id: id };
  }
  const raw = await DomainStorageService.load(auth, domainId, resolved.card_id);
  return { card: JSON.parse(raw.buffer.toString('utf-8')), card_data_id: resolved.card_id };
}

/** Helper: return the QR image data_id for a resolved key, or null. */
export async function findQrDataId(
  auth: DomainAuth,
  domainId: string,
  resolved: ResolvedKey,
): Promise<string | null> {
  if (resolved.via === 'registry') {
    const items = await DomainStorageService.listByType(auth, domainId, assetType(resolved.asset_id));
    const entry = items.find((i: DomainItem) => i.name === NAME_QR);
    return (entry && idOf(entry)) || null;
  }
  const imgs = await DomainStorageService.listByType(auth, domainId, 'qr_image');
  const entry = imgs.find((i: DomainItem) => i.name === `qr_${resolved.key}`);
  return (entry && idOf(entry)) || null;
}
