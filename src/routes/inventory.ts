import { Router } from 'express';
import { requireApiKey } from '../middleware/apiKey.js';
import { BridgeAuth } from '../services/AukiAuthService.js';
import { DomainStorageService } from '../services/DomainStorageService.js';
import { ContextCardSchema } from '../schemas/contextcard.js';

export const inventoryRoutes = Router();

type DomainItem = { id?: string; data_id?: string; name?: string; [k: string]: unknown };

function idOf(item: DomainItem): string | undefined {
  return item.id || item.data_id;
}

/**
 * GET /inventory?key=<api_key>
 * One-shot join of every contextcard with its qr_registry + qr_image entry,
 * plus the leftover orphans in each bucket. This is the source of truth
 * for the dashboard — what actually exists on the Auki domain right now.
 */
inventoryRoutes.get('/', requireApiKey, async (_req, res) => {
  try {
    const { auth, domainId } = await BridgeAuth.getDomainAuth();

    const [cardItems, registryItems, qrItems] = await Promise.all([
      DomainStorageService.listByType(auth, domainId, 'contextcard'),
      DomainStorageService.listByType(auth, domainId, 'qr_registry'),
      DomainStorageService.listByType(auth, domainId, 'qr_image'),
    ]);

    // Parse all registries in parallel; drop the ones we can't read.
    const registries = await Promise.all(
      registryItems.map(async (reg: DomainItem) => {
        const dataId = idOf(reg);
        if (!dataId) return null;
        try {
          const raw = await DomainStorageService.load(auth, domainId, dataId);
          const parsed = JSON.parse(raw.buffer.toString('utf-8'));
          return {
            data_id: dataId,
            name: reg.name ?? null,
            key: parsed.key || reg.name || null,
            card_id: parsed.card_id || null,
          };
        } catch {
          return { data_id: dataId, name: reg.name ?? null, key: null, card_id: null, _broken: true };
        }
      }),
    );
    const registriesClean = registries.filter((r): r is NonNullable<typeof r> => r !== null);

    // Build lookup tables once.
    const registryByCardId = new Map<string, typeof registriesClean[number]>();
    for (const r of registriesClean) {
      if (r.card_id) registryByCardId.set(r.card_id, r);
    }
    const qrByName = new Map<string, DomainItem>();
    for (const q of qrItems) if (q.name) qrByName.set(q.name, q);

    // Parse + classify cards.
    const cards = await Promise.all(
      cardItems.map(async (item: DomainItem) => {
        const dataId = idOf(item);
        if (!dataId) return null;
        const registry = registryByCardId.get(dataId) || null;
        const qrImage = registry?.key ? qrByName.get(`qr_${registry.key}`) || null : null;
        const issues: string[] = [];

        let card: unknown = null;
        try {
          const raw = await DomainStorageService.load(auth, domainId, dataId);
          const parsed = JSON.parse(raw.buffer.toString('utf-8'));
          const validation = ContextCardSchema.safeParse(parsed);
          if (validation.success) {
            card = validation.data;
          } else {
            card = parsed;
            issues.push('invalid_schema');
          }
        } catch {
          issues.push('load_failed');
        }

        if (!registry) issues.push('missing_registry');
        if (registry && !qrImage) issues.push('missing_qr_image');

        return {
          data_id: dataId,
          name: item.name ?? null,
          card,
          registry: registry
            ? { data_id: registry.data_id, key: registry.key, name: registry.name }
            : null,
          qr_image: qrImage ? { data_id: idOf(qrImage), name: qrImage.name ?? null } : null,
          issues,
        };
      }),
    );
    const cardsClean = cards.filter((c): c is NonNullable<typeof c> => c !== null);

    // Orphans: registries whose card_id isn't on the domain.
    const cardIds = new Set(cardItems.map(idOf).filter((x): x is string => !!x));
    const orphanRegistries = registriesClean
      .filter((r) => !r.card_id || !cardIds.has(r.card_id))
      .map((r) => ({
        data_id: r.data_id,
        name: r.name,
        key: r.key,
        card_id: r.card_id,
        reason: !r.card_id ? 'no_card_id' : 'card_missing',
      }));

    // Orphans: qr_images whose name doesn't map back to a live registry key.
    const liveQrNames = new Set(
      registriesClean.filter((r) => r.key).map((r) => `qr_${r.key}`),
    );
    const orphanQrImages = qrItems
      .filter((q) => !q.name || !liveQrNames.has(q.name))
      .map((q) => ({ data_id: idOf(q), name: q.name ?? null }));

    res.json({
      cards: cardsClean,
      orphan_registries: orphanRegistries,
      orphan_qr_images: orphanQrImages,
      summary: {
        cards: cardsClean.length,
        registries: registriesClean.length,
        qr_images: qrItems.length,
        issues:
          cardsClean.reduce((n, c) => n + c.issues.length, 0) +
          orphanRegistries.length +
          orphanQrImages.length,
      },
    });
  } catch (err: any) {
    console.error('[inventory]', err?.message);
    res.status(500).json({ error: 'Inventory failed', detail: err?.message });
  }
});

/**
 * DELETE /inventory/orphan/:data_id?key=<api_key>
 * Thin delete for entries the UI flagged as orphaned. Intentionally generic
 * — the UI decides what's an orphan, the bridge just does the delete.
 */
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
