import { Router } from 'express';
import crypto from 'crypto';
import QRCode from 'qrcode';
import { requireApiKey } from '../middleware/apiKey.js';
import { BridgeAuth } from '../services/AukiAuthService.js';
import { DomainStorageService } from '../services/DomainStorageService.js';
import { ContextCardSchema } from '../schemas/contextcard.js';
import {
  REGISTRY_TYPE,
  NAME_CARD,
  NAME_QR,
  assetType,
  resolveKey,
} from '../services/DomainLayout.js';

const BRIDGE_BASE_URL = (process.env.BRIDGE_BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');

export const deployRoutes = Router();

type DomainItem = { id?: string; data_id?: string; name?: string };
const idOf = (i: DomainItem) => i.id || i.data_id;

/**
 * POST /deploy?key=<api_key>
 * Body: { id: string, body: string, tools?: [...], execute_url?: string }
 *
 * Writes under the asset-folder layout:
 *   asset:<uuid>/card   — ContextCard JSON
 *   asset:<uuid>/qr     — PNG
 *   registry/<id>       — { asset_id, key }
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

    // If the key is already claimed, refuse — operator must delete first. Avoids
    // silent overwrites that would orphan the previous asset folder.
    const existing = await resolveKey(domainAuth, domainId, id);
    if (existing) {
      res.status(409).json({ error: `Key "${id}" already in use — delete the existing card first` });
      return;
    }

    // Strip asset_id from the card body; it's injected at resolve time.
    const { tool_refs } = req.body;
    const card: Record<string, unknown> = {
      body,
      ...(tools ? { tools } : {}),
      ...(Array.isArray(tool_refs) && tool_refs.length > 0 ? { tool_refs } : {}),
      ...(execute_url ? { execute_url } : {}),
    };
    const validation = ContextCardSchema.safeParse(card);
    if (!validation.success) {
      res.status(422).json({ error: 'Invalid ContextCard', issues: validation.error.issues });
      return;
    }

    const assetId = crypto.randomUUID();
    const folder = assetType(assetId);

    // 1. Card inside the asset folder.
    const cardDataId = await DomainStorageService.store(
      domainAuth,
      domainId,
      JSON.stringify(validation.data),
      { name: NAME_CARD, dataType: folder, contentType: 'application/json' },
    );

    // 2. QR PNG inside the asset folder.
    const resolveUrl = `${BRIDGE_BASE_URL}/resolve/${id}`;
    const pngBuffer = await QRCode.toBuffer(resolveUrl, { type: 'png', width: 400, margin: 2 });
    const qrDataId = await DomainStorageService.store(
      domainAuth,
      domainId,
      pngBuffer,
      { name: NAME_QR, dataType: folder, contentType: 'image/png' },
    );

    // 3. Registry entry so /resolve can find the asset folder by key.
    const registry = { asset_id: assetId, key: id };
    const registryDataId = await DomainStorageService.store(
      domainAuth,
      domainId,
      JSON.stringify(registry),
      { name: id, dataType: REGISTRY_TYPE, contentType: 'application/json' },
    );

    res.status(201).json({
      asset_id: assetId,
      card_data_id: cardDataId,
      qr_data_id: qrDataId,
      registry_data_id: registryDataId,
      qr_base64: pngBuffer.toString('base64'),
      resolve_url: resolveUrl,
    });
  } catch (err: any) {
    console.error('[deploy]', err.message);
    res.status(500).json({ error: 'Deploy failed', detail: err?.message });
  }
});

/**
 * PUT /deploy/:asset_id?key=<api_key>
 * Body: { body, tools?, execute_url? }
 * Replaces the card file inside the asset folder. History + QR untouched.
 */
deployRoutes.put('/:asset_id', requireApiKey, async (req, res) => {
  try {
    const { auth: domainAuth, domainId } = await BridgeAuth.getDomainAuth();
    const assetId = req.params.asset_id;
    const { body, tools, tool_refs, execute_url } = req.body;

    if (!body) {
      res.status(400).json({ error: 'body required' });
      return;
    }
    const card: Record<string, unknown> = {
      body,
      ...(tools ? { tools } : {}),
      ...(Array.isArray(tool_refs) && tool_refs.length > 0 ? { tool_refs } : {}),
      ...(execute_url ? { execute_url } : {}),
    };
    const validation = ContextCardSchema.safeParse(card);
    if (!validation.success) {
      res.status(422).json({ error: 'Invalid ContextCard', issues: validation.error.issues });
      return;
    }

    const folder = assetType(assetId);
    const items = await DomainStorageService.listByType(domainAuth, domainId, folder);
    const existingCard = items.find((i: DomainItem) => i.name === NAME_CARD);

    const newCardDataId = await DomainStorageService.store(
      domainAuth,
      domainId,
      JSON.stringify(validation.data),
      { name: NAME_CARD, dataType: folder, contentType: 'application/json' },
    );

    // Best-effort remove the old card file after the new one is in place.
    if (existingCard && idOf(existingCard) && idOf(existingCard) !== newCardDataId) {
      try {
        await DomainStorageService.delete(domainAuth, domainId, idOf(existingCard)!);
      } catch (e) {
        console.warn('[deploy PUT] stale card delete failed:', (e as Error).message);
      }
    }

    res.json({ asset_id: assetId, card_data_id: newCardDataId });
  } catch (err: any) {
    res.status(500).json({ error: 'Update failed', detail: err?.message });
  }
});

/**
 * DELETE /deploy/:asset_id?key=<api_key>
 * Removes the whole asset folder (card, QR, transcripts) + the registry entry.
 *
 * Back-compat: if :asset_id doesn't match a registry record, try it as the
 * legacy card_data_id — same behavior as the old flat layout.
 */
deployRoutes.delete('/:asset_id', requireApiKey, async (req, res) => {
  try {
    const { auth: domainAuth, domainId } = await BridgeAuth.getDomainAuth();
    const target = req.params.asset_id;
    const errors: string[] = [];

    // Find the registry entry — either by matching asset_id (new) or card_id (legacy).
    const modernRegs = await DomainStorageService.listByType(domainAuth, domainId, REGISTRY_TYPE);
    let registryHit: { data_id: string; key: string } | null = null;
    let resolvedAssetId: string | null = null;

    for (const reg of modernRegs) {
      const rid = idOf(reg);
      if (!rid) continue;
      try {
        const raw = await DomainStorageService.load(domainAuth, domainId, rid);
        const parsed = JSON.parse(raw.buffer.toString('utf-8'));
        if (parsed.asset_id === target) {
          registryHit = { data_id: rid, key: parsed.key || reg.name || '' };
          resolvedAssetId = parsed.asset_id;
          break;
        }
      } catch { /* skip broken */ }
    }

    if (resolvedAssetId) {
      // New-layout path: wipe the asset folder, then the registry entry.
      const folder = assetType(resolvedAssetId);
      const items = await DomainStorageService.listByType(domainAuth, domainId, folder);
      await Promise.all(
        items.map(async (i: DomainItem) => {
          const id = idOf(i);
          if (!id) return;
          try { await DomainStorageService.delete(domainAuth, domainId, id); }
          catch (e) { errors.push(`asset file ${id}: ${(e as Error).message}`); }
        }),
      );
      if (registryHit) {
        try { await DomainStorageService.delete(domainAuth, domainId, registryHit.data_id); }
        catch (e) { errors.push(`registry: ${(e as Error).message}`); }
      }
      res.json({ deleted: true, asset_id: resolvedAssetId, warnings: errors.length ? errors : undefined });
      return;
    }

    // Legacy fallback: treat :asset_id as the old card_data_id.
    let legacyKey: string | null = null;
    const legacyRegs = await DomainStorageService.listByType(domainAuth, domainId, 'qr_registry');
    for (const reg of legacyRegs) {
      const rid = idOf(reg);
      if (!rid) continue;
      try {
        const raw = await DomainStorageService.load(domainAuth, domainId, rid);
        const parsed = JSON.parse(raw.buffer.toString('utf-8'));
        if (parsed.card_id === target) {
          legacyKey = parsed.key || reg.name || null;
          await DomainStorageService.delete(domainAuth, domainId, rid);
          break;
        }
      } catch { /* skip */ }
    }
    if (legacyKey) {
      const imgs = await DomainStorageService.listByType(domainAuth, domainId, 'qr_image');
      const qr = imgs.find((e: DomainItem) => e.name === `qr_${legacyKey}`);
      if (qr && idOf(qr)) {
        try { await DomainStorageService.delete(domainAuth, domainId, idOf(qr)!); }
        catch (e) { errors.push(`legacy qr: ${(e as Error).message}`); }
      }
    }
    try { await DomainStorageService.delete(domainAuth, domainId, target); }
    catch (e) { errors.push(`legacy card: ${(e as Error).message}`); }

    if (errors.some((e) => e.startsWith('legacy card'))) {
      res.status(500).json({ error: 'Delete partially failed', details: errors });
    } else {
      res.json({ deleted: true, legacy: true, warnings: errors.length ? errors : undefined });
    }
  } catch (err: any) {
    console.error('[delete]', err.message);
    res.status(500).json({ error: 'Delete failed', detail: err?.message });
  }
});
