import { Router } from 'express';
import QRCode from 'qrcode';
import { requireApiKey } from '../middleware/apiKey.js';
import { BridgeAuth } from '../services/AukiAuthService.js';
import { DomainStorageService } from '../services/DomainStorageService.js';
import {
  assetType,
  findQrDataId,
  NAME_QR,
  resolveKey,
} from '../services/DomainLayout.js';

const BRIDGE_BASE_URL = (process.env.BRIDGE_BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');

export const qrRoutes = Router();

/**
 * GET /qr/:key?key=<api_key>
 * Get (or generate + persist) the QR PNG for a resolve key.
 */
qrRoutes.get('/:key', requireApiKey, async (req, res) => {
  try {
    const { auth, domainId } = await BridgeAuth.getDomainAuth();
    const key = req.params.key;

    const resolved = await resolveKey(auth, domainId, key);

    // Already stored? Serve it.
    if (resolved) {
      const existingId = await findQrDataId(auth, domainId, resolved);
      if (existingId) {
        const raw = await DomainStorageService.load(auth, domainId, existingId);
        res.set('Content-Type', 'image/png');
        res.send(raw.buffer);
        return;
      }
    }

    // Generate fresh.
    const resolveUrl = `${BRIDGE_BASE_URL}/resolve/${key}`;
    const pngBuffer = await QRCode.toBuffer(resolveUrl, { type: 'png', width: 400, margin: 2 });

    // Persist if we know where the asset folder is.
    if (resolved?.via === 'registry') {
      await DomainStorageService.store(auth, domainId, pngBuffer, {
        name: NAME_QR,
        dataType: assetType(resolved.asset_id),
        contentType: 'image/png',
      });
    } else if (resolved?.via === 'legacy') {
      await DomainStorageService.store(auth, domainId, pngBuffer, {
        name: `qr_${key}`,
        dataType: 'qr_image',
        contentType: 'image/png',
      });
    }
    // No resolved registry → just return the bytes; don't persist an unrooted QR.

    res.set('Content-Type', 'image/png');
    res.send(pngBuffer);
  } catch (err: any) {
    res.status(500).json({ error: 'QR generation failed', detail: err?.message });
  }
});
