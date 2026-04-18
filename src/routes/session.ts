import { Router } from 'express';
import { requireApiKey } from '../middleware/apiKey.js';
import { BridgeAuth } from '../services/AukiAuthService.js';
import { DomainStorageService } from '../services/DomainStorageService.js';
import { assetType, sessionName, parseSessionName } from '../services/DomainLayout.js';

export const sessionRoutes = Router();

type DomainItem = { id?: string; data_id?: string; name?: string };
const idOf = (i: DomainItem) => i.id || i.data_id;

const ALLOWED_ROLES = new Set(['user', 'assistant', 'system', 'tool']);
const MAX_TRANSCRIPT_ENTRIES = 500;

/**
 * POST /session/:asset_id/transcript?key=<api_key>
 * Body: { session_id: string, role: string, content: string, meta?: object }
 *
 * Append one transcript entry to the asset folder. Turn index auto-increments
 * based on existing entries for the given session_id.
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

    const folder = assetType(assetId);
    const items = await DomainStorageService.listByType(auth, domainId, folder);

    // Compute next turn for this session by scanning existing names.
    let nextTurn = 0;
    for (const item of items) {
      if (!item.name) continue;
      const parsed = parseSessionName(item.name);
      if (parsed && parsed.sessionId === session_id) {
        nextTurn = Math.max(nextTurn, parsed.turn + 1);
      }
    }

    const record = {
      asset_id: assetId,
      session_id,
      turn: nextTurn,
      role,
      content,
      ...(meta ? { meta } : {}),
      created_at: new Date().toISOString(),
    };
    const name = sessionName(session_id, nextTurn);

    const dataId = await DomainStorageService.store(auth, domainId, JSON.stringify(record), {
      name,
      dataType: folder,
      contentType: 'application/json',
    });

    res.status(201).json({ data_id: dataId, asset_id: assetId, session_id, turn: nextTurn });
  } catch (err: any) {
    console.error('[session append]', err?.message);
    res.status(500).json({ error: 'Append failed', detail: err?.message });
  }
});

/**
 * GET /session/:asset_id/transcript?key=<api_key>[&session_id=...][&limit=N]
 *
 * Fetch transcript entries for this asset. If session_id is omitted, returns
 * entries across all sessions for this asset (ordered by session then turn).
 * `limit` caps the number of returned entries (latest first).
 */
sessionRoutes.get('/:asset_id/transcript', requireApiKey, async (req, res) => {
  try {
    const { auth, domainId } = await BridgeAuth.getDomainAuth();
    const assetId = req.params.asset_id;
    const filterSession = typeof req.query.session_id === 'string' ? req.query.session_id : null;
    const rawLimit = Number(req.query.limit);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(Math.floor(rawLimit), MAX_TRANSCRIPT_ENTRIES)
      : MAX_TRANSCRIPT_ENTRIES;

    const folder = assetType(assetId);
    const items = await DomainStorageService.listByType(auth, domainId, folder);

    const matches: { item: DomainItem; sessionId: string; turn: number }[] = [];
    for (const item of items) {
      if (!item.name) continue;
      const parsed = parseSessionName(item.name);
      if (!parsed) continue;
      if (filterSession && parsed.sessionId !== filterSession) continue;
      matches.push({ item, sessionId: parsed.sessionId, turn: parsed.turn });
    }

    matches.sort((a, b) => {
      if (a.sessionId !== b.sessionId) return a.sessionId < b.sessionId ? -1 : 1;
      return a.turn - b.turn;
    });

    // If limit is tighter than match count, take the tail (most recent).
    const windowed = matches.length > limit ? matches.slice(-limit) : matches;

    const entries = await Promise.all(
      windowed.map(async ({ item }) => {
        const id = idOf(item);
        if (!id) return null;
        try {
          const raw = await DomainStorageService.load(auth, domainId, id);
          return JSON.parse(raw.buffer.toString('utf-8'));
        } catch {
          return null;
        }
      }),
    );

    res.json({
      asset_id: assetId,
      session_id: filterSession,
      count: entries.filter(Boolean).length,
      total_available: matches.length,
      entries: entries.filter(Boolean),
    });
  } catch (err: any) {
    console.error('[session fetch]', err?.message);
    res.status(500).json({ error: 'Fetch failed', detail: err?.message });
  }
});
