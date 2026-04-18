import { Router } from 'express';
import { requireApiKey } from '../middleware/apiKey.js';
import { BridgeAuth } from '../services/AukiAuthService.js';
import { ToolLibrary } from '../services/ToolLibrary.js';

export const toolsRoutes = Router();

/** GET /api/tools?key=<api_key> — List all presets, including built-ins. */
toolsRoutes.get('/', requireApiKey, async (_req, res) => {
  try {
    const { auth, domainId } = await BridgeAuth.getDomainAuth();
    const presets = await ToolLibrary.list(auth, domainId);
    res.json({ presets });
  } catch (err: any) {
    res.status(500).json({ error: 'List presets failed', detail: err?.message });
  }
});

/** GET /api/tools/:name?key=<api_key> — Fetch one preset by name. */
toolsRoutes.get('/:name', requireApiKey, async (req, res) => {
  try {
    const { auth, domainId } = await BridgeAuth.getDomainAuth();
    const preset = await ToolLibrary.getPreset(auth, domainId, req.params.name);
    if (!preset) {
      res.status(404).json({ error: `No preset: ${req.params.name}` });
      return;
    }
    res.json(preset);
  } catch (err: any) {
    res.status(500).json({ error: 'Load preset failed', detail: err?.message });
  }
});
