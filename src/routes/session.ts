import { Router } from 'express';
import { requireApiKey } from '../middleware/apiKey.js';
import { BridgeAuth } from '../services/AukiAuthService.js';
import { appendEntry, fetchEntries } from '../services/TranscriptStore.js';

export const sessionRoutes = Router();

const ALLOWED_ROLES = new Set(['user', 'assistant', 'system', 'tool']);

/**
 * POST /session/:asset_id/transcript?key=<api_key>
 * Body: { session_id, role, content, meta? }
 *
 * Role-based entry shape — for clients that want the classic chat-log format.
 * The tool dispatcher writes a different (question/response) shape into the
 * same folder; readers should treat entries as opaque JSON.
 */
sessionRoutes.post('/:asset_id/transcript', requireApiKey, async (req, res) => {
  try {
    const { auth, domainId } = await BridgeAuth.getDomainAuth();
    const assetId = req.params.asset_id;
    const { session_id, role, content, meta } = req.body || {};

    if (!session_id || typeof session_id !== 'string') {
      res.status(400).json({ error: 'session_id (string) required' });
      return;
    }
    if (!role || !ALLOWED_ROLES.has(role)) {
      res.status(400).json({ error: `role must be one of: ${Array.from(ALLOWED_ROLES).join(', ')}` });
      return;
    }
    if (typeof content !== 'string' || content.length === 0) {
      res.status(400).json({ error: 'content (non-empty string) required' });
      return;
    }

    const result = await appendEntry(auth, domainId, assetId, session_id, {
      role,
      content,
      ...(meta ? { meta } : {}),
    });
    res.status(201).json({ data_id: result.data_id, asset_id: assetId, session_id });
  } catch (err: any) {
    console.error('[session append]', err?.message);
    res.status(500).json({ error: 'Append failed', detail: err?.message });
  }
});

/**
 * GET /session/:asset_id/transcript?key=<api_key>[&session_id=...][&limit=N]
 */
sessionRoutes.get('/:asset_id/transcript', requireApiKey, async (req, res) => {
  try {
    const { auth, domainId } = await BridgeAuth.getDomainAuth();
    const assetId = req.params.asset_id;
    const sessionId = typeof req.query.session_id === 'string' ? req.query.session_id : null;
    const rawLimit = Number(req.query.limit);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : undefined;

    const { entries, total_available } = await fetchEntries(auth, domainId, assetId, { sessionId, limit });
    res.json({
      asset_id: assetId,
      session_id: sessionId,
      count: entries.length,
      total_available,
      entries,
    });
  } catch (err: any) {
    console.error('[session fetch]', err?.message);
    res.status(500).json({ error: 'Fetch failed', detail: err?.message });
  }
});
