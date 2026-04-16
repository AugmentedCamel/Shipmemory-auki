import { Router } from 'express';
import { requireApiKey } from '../middleware/apiKey.js';
import { BridgeAuth } from '../services/AukiAuthService.js';
import { DomainStorageService } from '../services/DomainStorageService.js';
import { ContextCardSchema } from '../schemas/contextcard.js';

export const resolveRoutes = Router();

/**
 * GET /resolve/:key?key=<api_key>
 * Looks up QR registry by name → loads the linked ContextCard.
 * Single lookup path: qr_registry name === key → card_id → card.
 */
resolveRoutes.get('/:key', requireApiKey, async (req, res) => {
  const key = req.params.key;
  console.log(`[resolve] key="${key}"`);

  try {
    const { auth, domainId } = await BridgeAuth.getDomainAuth();

    const registryEntries = await DomainStorageService.listByType(auth, domainId, 'qr_registry');
    console.log(`[resolve] ${registryEntries.length} registry entries, names: [${registryEntries.map((e: any) => e.name).join(', ')}]`);

    const entry = registryEntries.find((e: any) => e.name === key);
    if (!entry) {
      res.status(404).json({ error: `No registry entry for key: ${key}` });
      return;
    }

    const regRaw = await DomainStorageService.load(auth, domainId, entry.id || entry.data_id);
    const registry = JSON.parse(regRaw.buffer.toString('utf-8'));
    console.log(`[resolve] registry -> card_id=${registry.card_id}`);

    if (!registry.card_id) {
      res.status(404).json({ error: 'Registry entry missing card_id' });
      return;
    }

    const cardRaw = await DomainStorageService.load(auth, domainId, registry.card_id);
    const card = JSON.parse(cardRaw.buffer.toString('utf-8'));
    const result = ContextCardSchema.safeParse(card);
    if (!result.success) {
      console.log(`[resolve] Card validation failed:`, result.error.issues);
      res.status(422).json({ error: 'Invalid ContextCard on domain', issues: result.error.issues });
      return;
    }

    console.log(`[resolve] OK, returning card (body length=${result.data.body.length})`);
    res.json(result.data);
  } catch (err: any) {
    console.error('[resolve] Error:', err.message);
    res.status(500).json({ error: 'Resolve failed', detail: err?.message });
  }
});
