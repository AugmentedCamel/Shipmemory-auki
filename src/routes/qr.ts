import { Router } from 'express';
import QRCode from 'qrcode';
import { requireApiKey } from '../middleware/apiKey.js';
import { BridgeAuth } from '../services/AukiAuthService.js';
import { DomainStorageService } from '../services/DomainStorageService.js';

const BRIDGE_BASE_URL = (process.env.BRIDGE_BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');

export const qrRoutes = Router();

/**
 * GET /qr/:key?key=<api_key>
 * Get or generate a QR code PNG for a resolve key.
 */
qrRoutes.get('/:key', requireApiKey, async (req, res) => {
  try {
    const { auth, domainId } = await BridgeAuth.getDomainAuth();
    const key = req.params.key;
    const qrName = `qr_${key}`;

    // Check if QR already exists on domain
    const existing = await DomainStorageService.listByType(auth, domainId, 'qr_image');
    const found = existing.find((e: any) => e.name === qrName);

    if (found) {
      const raw = await DomainStorageService.load(auth, domainId, found.id || found.data_id);
      res.set('Content-Type', 'image/png');
      res.send(raw.buffer);
      return;
    }

    // Generate QR code
    const resolveUrl = `${BRIDGE_BASE_URL}/resolve/${key}`;
    const pngBuffer = await QRCode.toBuffer(resolveUrl, { type: 'png', width: 400, margin: 2 });

    // Store on domain
    await DomainStorageService.store(auth, domainId, pngBuffer, {
      name: qrName,
      dataType: 'qr_image',
      contentType: 'image/png',
    });

    res.set('Content-Type', 'image/png');
    res.send(pngBuffer);
  } catch (err: any) {
    res.status(500).json({ error: 'QR generation failed', detail: err?.message });
  }
});
