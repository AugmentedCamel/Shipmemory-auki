import { Router } from 'express';
import { requireApiKey } from '../middleware/apiKey.js';
import { BridgeAuth } from '../services/AukiAuthService.js';
import { DomainStorageService } from '../services/DomainStorageService.js';

export const sessionRoutes = Router();

/**
 * GET /session/:card_id/data/:data_key?key=<api_key>
 * Read the latest session entry for this card + data_key.
 */
sessionRoutes.get('/:card_id/data/:data_key', requireApiKey, async (req, res) => {
  try {
    const { auth, domainId } = await BridgeAuth.getDomainAuth();
    const { card_id, data_key } = req.params;
    const dataType = `session:${card_id}:${data_key}`;

    const items = await DomainStorageService.listByType(auth, domainId, dataType);
    if (items.length === 0) {
      res.status(404).json({ error: 'No session data found', card_id, data_key });
      return;
    }

    const latest = items[items.length - 1];
    const raw = await DomainStorageService.load(auth, domainId, latest.id || latest.data_id);
    const parsed = JSON.parse(raw.buffer.toString('utf-8'));
    res.json(parsed);
  } catch (err: any) {
    res.status(500).json({ error: 'Session read failed', detail: err?.message });
  }
});

/**
 * POST /session/:card_id/data?key=<api_key>
 * Body: { data_key: string, payload: object, session_id?: string }
 */
sessionRoutes.post('/:card_id/data', requireApiKey, async (req, res) => {
  try {
    const { auth, domainId } = await BridgeAuth.getDomainAuth();
    const { card_id } = req.params;
    const { data_key, payload, session_id } = req.body;

    if (!data_key || !payload) {
      res.status(400).json({ error: 'data_key and payload required' });
      return;
    }

    const dataType = `session:${card_id}:${data_key}`;
    const record = {
      card_id,
      data_key,
      session_id: session_id || `s_${Date.now()}`,
      payload,
      created_at: new Date().toISOString(),
    };

    const dataId = await DomainStorageService.store(auth, domainId, JSON.stringify(record), {
      dataType,
      contentType: 'application/json',
    });

    res.status(201).json({ dataId, session_id: record.session_id });
  } catch (err: any) {
    res.status(500).json({ error: 'Session write failed', detail: err?.message });
  }
});
