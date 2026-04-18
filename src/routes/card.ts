import { Router } from 'express';
import { requireApiKey } from '../middleware/apiKey.js';
import { BridgeAuth } from '../services/AukiAuthService.js';
import { DomainStorageService } from '../services/DomainStorageService.js';
import { ContextCardSchema } from '../schemas/contextcard.js';
import { REGISTRY_TYPE, NAME_CARD, assetType } from '../services/DomainLayout.js';

export const cardRoutes = Router();

type DomainItem = { id?: string; data_id?: string; name?: string };
const idOf = (i: DomainItem) => i.id || i.data_id;

/**
 * GET /card?key=<api_key>
 * List every ContextCard on the domain — new asset-folder layout first,
 * then any legacy flat contextcards that don't have a modern registry.
 */
cardRoutes.get('/', requireApiKey, async (_req, res) => {
  try {
    const { auth, domainId } = await BridgeAuth.getDomainAuth();
    const out: any[] = [];

    // --- New layout: registry → asset folder → card file ---
    const modernRegs = await DomainStorageService.listByType(auth, domainId, REGISTRY_TYPE);
    const assetIdsSeen = new Set<string>();

    for (const reg of modernRegs) {
      const rid = idOf(reg);
      if (!rid) continue;
      try {
        const rraw = await DomainStorageService.load(auth, domainId, rid);
        const parsed = JSON.parse(rraw.buffer.toString('utf-8'));
        const assetId = parsed.asset_id;
        const key = parsed.key || reg.name || null;
        if (!assetId) continue;
        assetIdsSeen.add(assetId);

        const folder = assetType(assetId);
        const items = await DomainStorageService.listByType(auth, domainId, folder);
        const cardItem = items.find((i: DomainItem) => i.name === NAME_CARD);
        if (!cardItem || !idOf(cardItem)) {
          out.push({ _layout: 'asset', _asset_id: assetId, _registry_key: key, _error: 'Missing card in asset folder' });
          continue;
        }
        const craw = await DomainStorageService.load(auth, domainId, idOf(cardItem)!);
        const card = JSON.parse(craw.buffer.toString('utf-8'));
        out.push({
          _layout: 'asset',
          _asset_id: assetId,
          _data_id: idOf(cardItem),
          _registry_key: key,
          _name: cardItem.name,
          ...card,
        });
      } catch { /* skip broken registry */ }
    }

    // --- Legacy layout: free-standing contextcard entries + qr_registry joins ---
    const legacyCards = await DomainStorageService.listByType(auth, domainId, 'contextcard');
    const legacyRegs = await DomainStorageService.listByType(auth, domainId, 'qr_registry');
    const legacyMap = new Map<string, string>();
    await Promise.all(
      legacyRegs.map(async (reg: DomainItem) => {
        const rid = idOf(reg);
        if (!rid) return;
        try {
          const raw = await DomainStorageService.load(auth, domainId, rid);
          const parsed = JSON.parse(raw.buffer.toString('utf-8'));
          if (parsed.card_id) legacyMap.set(parsed.card_id, parsed.key || reg.name);
        } catch { /* skip */ }
      }),
    );

    for (const item of legacyCards) {
      const did = idOf(item);
      if (!did) continue;
      try {
        const raw = await DomainStorageService.load(auth, domainId, did);
        const parsed = JSON.parse(raw.buffer.toString('utf-8'));
        out.push({
          _layout: 'legacy',
          _data_id: did,
          _name: item.name,
          _registry_key: legacyMap.get(did) || null,
          ...parsed,
        });
      } catch {
        out.push({ _layout: 'legacy', _data_id: did, _name: item.name, _error: 'Failed to load' });
      }
    }

    res.json(out);
  } catch (err: any) {
    res.status(500).json({ error: 'List cards failed', detail: err?.message });
  }
});

/** GET /card/:id?key=<api_key> — Fetch ContextCard by domain data ID */
cardRoutes.get('/:id', requireApiKey, async (req, res) => {
  try {
    const { auth, domainId } = await BridgeAuth.getDomainAuth();
    const raw = await DomainStorageService.load(auth, domainId, req.params.id);
    const card = JSON.parse(raw.buffer.toString('utf-8'));
    const result = ContextCardSchema.safeParse(card);
    if (!result.success) {
      res.status(422).json({ error: 'Invalid ContextCard', issues: result.error.issues });
      return;
    }
    res.json(result.data);
  } catch (err: any) {
    const status = err?.response?.status || 500;
    res.status(status).json({ error: 'Card fetch failed', detail: err?.message });
  }
});

/** GET /card/:id/tools?key=<api_key> — Tools array from a card */
cardRoutes.get('/:id/tools', requireApiKey, async (req, res) => {
  try {
    const { auth, domainId } = await BridgeAuth.getDomainAuth();
    const raw = await DomainStorageService.load(auth, domainId, req.params.id);
    const card = JSON.parse(raw.buffer.toString('utf-8'));
    const result = ContextCardSchema.safeParse(card);
    if (!result.success) {
      res.status(422).json({ error: 'Invalid ContextCard', issues: result.error.issues });
      return;
    }
    res.json(result.data.tools || []);
  } catch (err: any) {
    res.status(500).json({ error: 'Tools fetch failed', detail: err?.message });
  }
});
