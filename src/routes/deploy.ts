import { Router } from 'express';
import QRCode from 'qrcode';
import { requireApiKey } from '../middleware/apiKey.js';
import { BridgeAuth } from '../services/AukiAuthService.js';
import { DomainStorageService } from '../services/DomainStorageService.js';
import { ContextCardSchema } from '../schemas/contextcard.js';

const BRIDGE_BASE_URL = (process.env.BRIDGE_BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');

export const deployRoutes = Router();

/**
 * POST /deploy?key=<api_key>
 * Body: { id: string, body: string, tools?: [...], execute_url?: string }
 */
deployRoutes.post('/', requireApiKey, async (req, res) => {
  try {
    const { auth: domainAuth, domainId } = await BridgeAuth.getDomainAuth();
    const { id, body, tools, execute_url } = req.body;

    if (!id || !body) {
      res.status(400).json({ error: 'id and body required' });
      return;
    }

    if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
      res.status(400).json({ error: 'id must be URL-safe (alphanumeric, hyphens, underscores)' });
      return;
    }

    // 1. Build and validate ContextCard
    const card: Record<string, unknown> = { body, ...(tools ? { tools } : {}), ...(execute_url ? { execute_url } : {}) };

    const validation = ContextCardSchema.safeParse(card);
    if (!validation.success) {
      res.status(422).json({ error: 'Invalid ContextCard', issues: validation.error.issues });
      return;
    }

    // 2. Store ContextCard on domain
    const cardDataId = await DomainStorageService.store(
      domainAuth,
      domainId,
      JSON.stringify(validation.data),
      { dataType: 'contextcard', contentType: 'application/json' },
    );

    // 3. Store QR registry entry (maps key → card data ID)
    const registry = { card_id: cardDataId, key: id };
    const registryDataId = await DomainStorageService.store(
      domainAuth,
      domainId,
      JSON.stringify(registry),
      { name: id, dataType: 'qr_registry', contentType: 'application/json' },
    );

    // 4. Generate QR code PNG
    const resolveUrl = `${BRIDGE_BASE_URL}/resolve/${id}`;
    const pngBuffer = await QRCode.toBuffer(resolveUrl, { type: 'png', width: 400, margin: 2 });

    // 5. Store QR image on domain
    const qrDataId = await DomainStorageService.store(
      domainAuth,
      domainId,
      pngBuffer,
      { name: `qr_${id}`, dataType: 'qr_image', contentType: 'image/png' },
    );

    const qrBase64 = pngBuffer.toString('base64');

    res.status(201).json({
      card_data_id: cardDataId,
      registry_data_id: registryDataId,
      qr_data_id: qrDataId,
      qr_base64: qrBase64,
      resolve_url: resolveUrl,
    });
  } catch (err: any) {
    console.error('[deploy]', err.message);
    res.status(500).json({ error: 'Deploy failed', detail: err?.message });
  }
});

/**
 * PUT /deploy/:card_data_id?key=<api_key>
 * Body: { body: string, tools?: [...], execute_url?: string }
 */
deployRoutes.put('/:card_data_id', requireApiKey, async (req, res) => {
  try {
    const { auth: domainAuth, domainId } = await BridgeAuth.getDomainAuth();
    const { card_data_id } = req.params;
    const { body, tools, execute_url } = req.body;

    if (!body) {
      res.status(400).json({ error: 'body required' });
      return;
    }

    const card: Record<string, unknown> = { body, ...(tools ? { tools } : {}), ...(execute_url ? { execute_url } : {}) };

    const validation = ContextCardSchema.safeParse(card);
    if (!validation.success) {
      res.status(422).json({ error: 'Invalid ContextCard', issues: validation.error.issues });
      return;
    }

    const newCardDataId = await DomainStorageService.store(
      domainAuth,
      domainId,
      JSON.stringify(validation.data),
      { dataType: 'contextcard', contentType: 'application/json' },
    );

    res.json({ card_data_id: newCardDataId });
  } catch (err: any) {
    res.status(500).json({ error: 'Update failed', detail: err?.message });
  }
});

/**
 * DELETE /deploy/:card_data_id?key=<api_key>
 * Deletes the card, its QR registry entry, and QR image from the domain.
 */
deployRoutes.delete('/:card_data_id', requireApiKey, async (req, res) => {
  try {
    const { auth: domainAuth, domainId } = await BridgeAuth.getDomainAuth();
    const { card_data_id } = req.params;
    const errors: string[] = [];

    // 1. Load the card to get its name (used for registry + QR lookup)
    let cardName: string | null = null;
    try {
      const raw = await DomainStorageService.load(domainAuth, domainId, card_data_id);
      const card = JSON.parse(raw.buffer.toString('utf-8'));
      // Try to find the registry entry that points to this card
      const registries = await DomainStorageService.listByType(domainAuth, domainId, 'qr_registry');
      for (const reg of registries) {
        try {
          const regRaw = await DomainStorageService.load(domainAuth, domainId, reg.id || reg.data_id);
          const regData = JSON.parse(regRaw.buffer.toString('utf-8'));
          if (regData.card_id === card_data_id) {
            cardName = regData.key || reg.name;
            // Delete registry entry
            await DomainStorageService.delete(domainAuth, domainId, reg.id || reg.data_id);
            break;
          }
        } catch { /* skip broken registry entries */ }
      }
    } catch (e: any) {
      errors.push('Could not load card: ' + e.message);
    }

    // 2. Delete QR image if we found the card name
    if (cardName) {
      try {
        const qrImages = await DomainStorageService.listByType(domainAuth, domainId, 'qr_image');
        const qr = qrImages.find((e: any) => e.name === `qr_${cardName}`);
        if (qr) {
          await DomainStorageService.delete(domainAuth, domainId, qr.id || qr.data_id);
        }
      } catch (e: any) {
        errors.push('QR delete failed: ' + e.message);
      }
    }

    // 3. Delete the card itself
    try {
      await DomainStorageService.delete(domainAuth, domainId, card_data_id);
    } catch (e: any) {
      errors.push('Card delete failed: ' + e.message);
    }

    if (errors.length > 0 && errors.some(e => e.includes('Card delete failed'))) {
      res.status(500).json({ error: 'Delete partially failed', details: errors });
    } else {
      res.json({ deleted: true, warnings: errors.length > 0 ? errors : undefined });
    }
  } catch (err: any) {
    console.error('[delete]', err.message);
    res.status(500).json({ error: 'Delete failed', detail: err?.message });
  }
});
