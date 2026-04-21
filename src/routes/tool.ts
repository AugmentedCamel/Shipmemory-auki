import { Router } from 'express';
import { requireApiKey } from '../middleware/apiKey.js';
import { BridgeAuth } from '../services/AukiAuthService.js';
import { appendEntry, fetchEntries } from '../services/TranscriptStore.js';

export const toolRoutes = Router();

/**
 * POST /tool/:asset_id?key=<api_key>
 * Body: { tool: string, params?: object }
 *
 * Single dispatcher URL per card. Clients that execute agent tool calls
 * forward them here; the bridge routes by tool name to its built-in handler.
 * Unknown tools get 404 — hosts that run custom tools should point the
 * card's execute_url at their own dispatcher instead.
 */
toolRoutes.post('/:asset_id', requireApiKey, async (req, res) => {
  const assetId = req.params.asset_id;
  const { tool, params } = req.body || {};
  console.log(`[tool] asset=${assetId} tool=${tool} params=${JSON.stringify(params)}`);

  try {
    const { auth, domainId } = await BridgeAuth.getDomainAuth();

    if (!tool || typeof tool !== 'string') {
      res.status(400).json({ error: 'tool (string) required' });
      return;
    }

    if (tool === 'session_history') {
      const result = await handleSessionHistory(auth, domainId, assetId, params || {});
      res.status(result.status).json(result.body);
      return;
    }

    res.status(404).json({ error: `Unknown built-in tool: ${tool}` });
  } catch (err: any) {
    const upstreamStatus = err?.response?.status;
    const upstreamData = err?.response?.data;
    const upstreamDataStr =
      Buffer.isBuffer(upstreamData) ? upstreamData.toString('utf-8')
      : typeof upstreamData === 'object' ? JSON.stringify(upstreamData)
      : String(upstreamData);
    console.error(
      `[tool dispatcher] tool=${tool} asset=${assetId} upstream_status=${upstreamStatus} upstream=${upstreamDataStr} message=${err?.message}`,
    );
    res.status(500).json({
      error: 'Dispatch failed',
      detail: err?.message,
      upstream_status: upstreamStatus,
      upstream: upstreamData,
    });
  }
});

async function handleSessionHistory(
  auth: any,
  domainId: string,
  assetId: string,
  params: Record<string, any>,
): Promise<{ status: number; body: any }> {
  const action = params.action;

  if (action === 'append') {
    const { session_id, question, response, notes } = params;
    if (!session_id || typeof session_id !== 'string') {
      return { status: 400, body: { error: 'session_id (string) required for append' } };
    }
    if (typeof question !== 'string' || question.length === 0) {
      return { status: 400, body: { error: 'question (non-empty string) required for append' } };
    }
    if (typeof response !== 'string' || response.length === 0) {
      return { status: 400, body: { error: 'response (non-empty string) required for append' } };
    }
    const extra: Record<string, unknown> = { kind: 'turn', question, response };
    if (typeof notes === 'string' && notes.length > 0) extra.notes = notes;
    const result = await appendEntry(auth, domainId, assetId, session_id, extra);
    return { status: 201, body: { ok: true, data_id: result.data_id } };
  }

  if (action === 'read') {
    const sessionId = typeof params.session_id === 'string' ? params.session_id : null;
    const rawLimit = Number(params.limit);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : 20;
    const fetched = await fetchEntries(auth, domainId, assetId, { sessionId, limit });
    return {
      status: 200,
      body: {
        ok: true,
        session_id: sessionId,
        entries: fetched.entries,
        total_available: fetched.total_available,
      },
    };
  }

  return { status: 400, body: { error: "action must be 'append' or 'read'" } };
}
