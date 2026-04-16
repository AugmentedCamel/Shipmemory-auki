import { Router } from 'express';
import { requireApiKey } from '../middleware/apiKey.js';
import { BridgeAuth } from '../services/AukiAuthService.js';
import { DomainStorageService } from '../services/DomainStorageService.js';
import { ContextCardSchema } from '../schemas/contextcard.js';

export const cardRoutes = Router();

/** GET /card?key=<api_key> — List all ContextCards on the domain, with full content */
cardRoutes.get('/', requireApiKey, async (req, res) => {
  try {
    const { auth, domainId } = await BridgeAuth.getDomainAuth();
    const items = await DomainStorageService.listByType(auth, domainId, 'contextcard');

    // Build registry lookup: card_data_id → registry key
    const registries = await DomainStorageService.listByType(auth, domainId, 'qr_registry');
    const registryMap = new Map<string, string>();
    await Promise.all(
      registries.map(async (reg: any) => {
        try {
          const raw = await DomainStorageService.load(auth, domainId, reg.id || reg.data_id);
          const data = JSON.parse(raw.buffer.toString('utf-8'));
          if (data.card_id) registryMap.set(data.card_id, data.key || reg.name);
        } catch { /* skip broken entries */ }
      }),
    );

    // Load and parse each card's actual content
    const cards = await Promise.all(
      items.map(async (item: any) => {
        const dataId = item.id || item.data_id;
        if (!dataId) return null;
        try {
          const raw = await DomainStorageService.load(auth, domainId, dataId);
          const parsed = JSON.parse(raw.buffer.toString('utf-8'));
          const registryKey = registryMap.get(dataId);
          return { _data_id: dataId, _name: item.name, _registry_key: registryKey || null, ...parsed };
        } catch {
          return { _data_id: dataId, _name: item.name, _registry_key: null, _error: 'Failed to load' };
        }
      }),
    );

    res.json(cards.filter(Boolean));
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
