import { Router } from 'express';
import { requireApiKey } from '../middleware/apiKey.js';
import { BridgeAuth } from '../services/AukiAuthService.js';
import { ContextCardSchema } from '../schemas/contextcard.js';
import { resolveKey, loadCardForResolved } from '../services/DomainLayout.js';

export const resolveRoutes = Router();

/**
 * GET /resolve/:key?key=<api_key>
 *
 * 1. Look up the registry entry by key (new layout first, legacy fallback).
 * 2. Load the card from the resolved location.
 * 3. Inject asset_id into the response so clients can target the asset
 *    folder for transcript tools.
 */
resolveRoutes.get('/:key', requireApiKey, async (req, res) => {
  const key = req.params.key;
  console.log(`[resolve] key="${key}"`);

  try {
    const { auth, domainId } = await BridgeAuth.getDomainAuth();

    const resolved = await resolveKey(auth, domainId, key);
    if (!resolved) {
      res.status(404).json({ error: `No registry entry for key: ${key}` });
      return;
    }

    const loaded = await loadCardForResolved(auth, domainId, resolved);
    if (!loaded) {
      res.status(404).json({ error: 'Registry found but card is missing in the asset folder' });
      return;
    }

    const validation = ContextCardSchema.safeParse(loaded.card);
    if (!validation.success) {
      console.log('[resolve] card validation failed:', validation.error.issues);
      res.status(422).json({ error: 'Invalid ContextCard on domain', issues: validation.error.issues });
      return;
    }

    const assetId = resolved.via === 'registry' ? resolved.asset_id : loaded.card_data_id;
    const response = { ...validation.data, asset_id: assetId };
    console.log(`[resolve] OK via=${resolved.via} asset_id=${assetId} body_len=${response.body.length}`);
    res.json(response);
  } catch (err: any) {
    console.error('[resolve] Error:', err?.message);
    res.status(500).json({ error: 'Resolve failed', detail: err?.message });
  }
});
