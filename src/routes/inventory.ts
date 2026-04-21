import { Router } from 'express';
import { requireApiKey } from '../middleware/apiKey.js';
import { BridgeAuth } from '../services/AukiAuthService.js';
import { DomainStorageService } from '../services/DomainStorageService.js';
import { ContextCardSchema } from '../schemas/contextcard.js';
import {
  REGISTRY_TYPE,
  assetType,
  cardNameFor,
  qrNameFor,
  isSessionHistoryName,
} from '../services/DomainLayout.js';

export const inventoryRoutes = Router();

type DomainItem = { id?: string; data_id?: string; name?: string };
const idOf = (i: DomainItem) => i.id || i.data_id;

/**
 * GET /inventory?key=<api_key>
 * Joined view of every card on the domain across both layouts plus orphan
 * buckets. This is the source of truth for the dashboard.
 */
inventoryRoutes.get('/', requireApiKey, async (_req, res) => {
  try {
    const { auth, domainId } = await BridgeAuth.getDomainAuth();

    const [modernRegs, legacyCards, legacyRegs, legacyQrs] = await Promise.all([
      DomainStorageService.listByType(auth, domainId, REGISTRY_TYPE),
      DomainStorageService.listByType(auth, domainId, 'contextcard'),
      DomainStorageService.listByType(auth, domainId, 'qr_registry'),
      DomainStorageService.listByType(auth, domainId, 'qr_image'),
    ]);

    const cards: any[] = [];
    const orphanRegistries: any[] = [];

    // --- New layout ---
    for (const reg of modernRegs) {
      const regId = idOf(reg);
      if (!regId) continue;
      let parsed: any = null;
      try {
        const raw = await DomainStorageService.load(auth, domainId, regId);
        parsed = JSON.parse(raw.buffer.toString('utf-8'));
      } catch {
        orphanRegistries.push({
          layout: 'asset',
          data_id: regId,
          name: reg.name ?? null,
          reason: 'unreadable',
        });
        continue;
      }

      const assetId: string | undefined = parsed?.asset_id;
      const key = parsed?.key || reg.name || null;
      if (!assetId) {
        orphanRegistries.push({
          layout: 'asset',
          data_id: regId,
          name: reg.name ?? null,
          key,
          reason: 'no_asset_id',
        });
        continue;
      }

      const items = await DomainStorageService.listByType(auth, domainId, assetType(assetId));
      const cardItem = items.find((i: DomainItem) => i.name === cardNameFor(assetId));
      const qrItem = items.find((i: DomainItem) => i.name === qrNameFor(assetId));

      if (!cardItem || !idOf(cardItem)) {
        orphanRegistries.push({
          layout: 'asset',
          data_id: regId,
          key,
          asset_id: assetId,
          reason: 'asset_missing_card',
        });
        continue;
      }

      let card: unknown = null;
      const issues: string[] = [];
      try {
        const raw = await DomainStorageService.load(auth, domainId, idOf(cardItem)!);
        const cardParsed = JSON.parse(raw.buffer.toString('utf-8'));
        const validation = ContextCardSchema.safeParse(cardParsed);
        if (validation.success) card = validation.data;
        else { card = cardParsed; issues.push('invalid_schema'); }
      } catch {
        issues.push('load_failed');
      }
      if (!qrItem) issues.push('missing_qr');

      // Count session_history entries cheaply by name prefix. Session count
      // would require loading each entry's payload, so we skip it for
      // inventory — transcript_entries is enough signal on the card row.
      const sessionTurns = items.filter(
        (i: DomainItem) => i.name && isSessionHistoryName(i.name),
      );
      const sessionIds = new Set<string>();

      cards.push({
        layout: 'asset',
        asset_id: assetId,
        data_id: idOf(cardItem),
        name: cardItem.name ?? null,
        card,
        registry: { data_id: regId, key },
        qr_image: qrItem ? { data_id: idOf(qrItem), name: qrItem.name ?? null } : null,
        session_count: sessionIds.size,
        transcript_entries: sessionTurns.length,
        issues,
      });
    }

    // --- Legacy layout ---
    const legacyRegByCardId = new Map<string, { data_id: string; key: string | null }>();
    for (const reg of legacyRegs) {
      const rid = idOf(reg);
      if (!rid) continue;
      try {
        const raw = await DomainStorageService.load(auth, domainId, rid);
        const parsed = JSON.parse(raw.buffer.toString('utf-8'));
        if (parsed.card_id) {
          legacyRegByCardId.set(parsed.card_id, { data_id: rid, key: parsed.key || reg.name || null });
        } else {
          orphanRegistries.push({ layout: 'legacy', data_id: rid, name: reg.name ?? null, reason: 'no_card_id' });
        }
      } catch {
        orphanRegistries.push({ layout: 'legacy', data_id: rid, name: reg.name ?? null, reason: 'unreadable' });
      }
    }

    const legacyCardIds = new Set(legacyCards.map(idOf).filter((x): x is string => !!x));
    for (const item of legacyCards) {
      const did = idOf(item);
      if (!did) continue;
      const reg = legacyRegByCardId.get(did);
      const key = reg?.key || null;
      let card: unknown = null;
      const issues: string[] = [];
      try {
        const raw = await DomainStorageService.load(auth, domainId, did);
        const parsed = JSON.parse(raw.buffer.toString('utf-8'));
        const validation = ContextCardSchema.safeParse(parsed);
        if (validation.success) card = validation.data;
        else { card = parsed; issues.push('invalid_schema'); }
      } catch {
        issues.push('load_failed');
      }
      if (!reg) issues.push('missing_registry');
      const qr = key ? legacyQrs.find((q: DomainItem) => q.name === `qr_${key}`) : null;
      if (reg && !qr) issues.push('missing_qr_image');

      cards.push({
        layout: 'legacy',
        asset_id: null,
        data_id: did,
        name: item.name ?? null,
        card,
        registry: reg ? { data_id: reg.data_id, key } : null,
        qr_image: qr ? { data_id: idOf(qr), name: qr.name ?? null } : null,
        session_count: null,
        transcript_entries: null,
        issues,
      });
    }

    // Legacy registries pointing at a card that no longer exists.
    for (const [cardId, reg] of legacyRegByCardId.entries()) {
      if (!legacyCardIds.has(cardId)) {
        orphanRegistries.push({
          layout: 'legacy',
          data_id: reg.data_id,
          key: reg.key,
          card_id: cardId,
          reason: 'card_missing',
        });
      }
    }

    // Legacy QR images not claimed by a legacy registry key.
    const liveLegacyQrNames = new Set(
      Array.from(legacyRegByCardId.values())
        .map((r) => (r.key ? `qr_${r.key}` : null))
        .filter((x): x is string => !!x),
    );
    const orphanQrImages = legacyQrs
      .filter((q: DomainItem) => !q.name || !liveLegacyQrNames.has(q.name))
      .map((q: DomainItem) => ({ data_id: idOf(q), name: q.name ?? null }));

    const issueCount =
      cards.reduce((n, c) => n + (c.issues?.length || 0), 0) +
      orphanRegistries.length +
      orphanQrImages.length;

    res.json({
      cards,
      orphan_registries: orphanRegistries,
      orphan_qr_images: orphanQrImages,
      summary: {
        cards: cards.length,
        asset_cards: cards.filter((c) => c.layout === 'asset').length,
        legacy_cards: cards.filter((c) => c.layout === 'legacy').length,
        registries: modernRegs.length + legacyRegs.length,
        qr_images: legacyQrs.length + cards.filter((c) => c.layout === 'asset' && c.qr_image).length,
        issues: issueCount,
      },
    });
  } catch (err: any) {
    console.error('[inventory]', err?.message);
    res.status(500).json({ error: 'Inventory failed', detail: err?.message });
  }
});

/** DELETE /inventory/orphan/:data_id — generic delete for orphaned entries. */
inventoryRoutes.delete('/orphan/:data_id', requireApiKey, async (req, res) => {
  try {
    const { auth, domainId } = await BridgeAuth.getDomainAuth();
    await DomainStorageService.delete(auth, domainId, req.params.data_id);
    res.json({ deleted: true });
  } catch (err: any) {
    const status = err?.response?.status || 500;
    res.status(status).json({ error: 'Delete failed', detail: err?.message });
  }
});
