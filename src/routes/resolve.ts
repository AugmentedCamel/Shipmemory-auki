import { Router } from 'express';
import { requireApiKey } from '../middleware/apiKey.js';
import { BridgeAuth } from '../services/AukiAuthService.js';
import { ContextCardSchema, type Tool } from '../schemas/contextcard.js';
import { resolveKey, loadCardForResolved } from '../services/DomainLayout.js';
import { ToolLibrary } from '../services/ToolLibrary.js';

const BRIDGE_BASE_URL = (process.env.BRIDGE_BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');

export const resolveRoutes = Router();

/**
 * GET /resolve/:key?key=<api_key>
 *
 * 1. Look up the registry entry by key (new layout first, legacy fallback).
 * 2. Load the card from the resolved location.
 * 3. Expand any `tool_refs` into full tool definitions from the tool library.
 * 4. If any expanded tool is a built-in and the card has no explicit
 *    execute_url, point it at the bridge's dispatcher for this asset.
 * 5. Inject asset_id into the response.
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

    const stored = validation.data;
    const assetId = resolved.via === 'registry' ? resolved.asset_id : loaded.card_data_id;

    // --- Expand tool_refs into full tool JSON ---
    const expandedTools: Tool[] = stored.tools ? [...stored.tools] : [];
    let hasBuiltin = false;
    if (stored.tool_refs && stored.tool_refs.length > 0) {
      for (const ref of stored.tool_refs) {
        const preset = await ToolLibrary.getPreset(auth, domainId, ref);
        if (!preset) {
          console.log(`[resolve] tool_ref "${ref}" missing — skipping`);
          continue;
        }
        if (preset.builtin) hasBuiltin = true;
        expandedTools.push({
          name: preset.name,
          description: preset.description,
          parameters: preset.parameters,
        });
      }
    }

    // --- Decide execute_url ---
    // Card's own execute_url wins (custom dispatcher). Otherwise, if the card
    // references any built-in tool, point at the bridge's dispatcher so the
    // client has exactly one URL to post tool calls to.
    const executeUrl = stored.execute_url ?? (hasBuiltin ? `${BRIDGE_BASE_URL}/tool/${assetId}` : undefined);

    const response = {
      body: stored.body,
      ...(expandedTools.length > 0 ? { tools: expandedTools } : {}),
      ...(executeUrl ? { execute_url: executeUrl } : {}),
      asset_id: assetId,
    };

    console.log(
      `[resolve] OK via=${resolved.via} asset=${assetId} tools=${expandedTools.length} builtin=${hasBuiltin}`,
    );
    res.json(response);
  } catch (err: any) {
    console.error('[resolve] Error:', err?.message);
    res.status(500).json({ error: 'Resolve failed', detail: err?.message });
  }
});
