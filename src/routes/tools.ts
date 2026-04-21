import { Router } from 'express';
import { requireApiKey } from '../middleware/apiKey.js';
import { BridgeAuth } from '../services/AukiAuthService.js';
import { BUILTIN_PRESETS, ToolLibrary, type ToolPreset } from '../services/ToolLibrary.js';

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

/**
 * POST /api/tools?key=<api_key>
 * Body: { name, description, parameters, builtin?, execute_url? }
 *
 * Create or overwrite a tool preset on the domain. Saving a preset with the
 * same name as a built-in effectively overrides the built-in definition (the
 * domain copy wins).
 */
toolsRoutes.post('/', requireApiKey, async (req, res) => {
  try {
    const body = req.body || {};
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const description = typeof body.description === 'string' ? body.description : '';
    const parameters = body.parameters;

    if (!name) {
      res.status(400).json({ error: 'name (non-empty string) required' });
      return;
    }
    if (!/^[a-zA-Z0-9_.-]+$/.test(name)) {
      res
        .status(400)
        .json({ error: 'name must be alphanumeric with _ . - (no spaces or colons)' });
      return;
    }
    if (typeof description !== 'string' || description.length === 0) {
      res.status(400).json({ error: 'description (non-empty string) required' });
      return;
    }
    if (!parameters || typeof parameters !== 'object') {
      res.status(400).json({ error: 'parameters (JSON Schema object) required' });
      return;
    }

    const preset: ToolPreset = {
      name,
      description,
      parameters,
      ...(typeof body.builtin === 'string' && body.builtin.length > 0 ? { builtin: body.builtin } : {}),
      ...(typeof body.execute_url === 'string' && body.execute_url.length > 0
        ? { execute_url: body.execute_url }
        : {}),
    };

    const { auth, domainId } = await BridgeAuth.getDomainAuth();
    await ToolLibrary.savePreset(auth, domainId, preset);
    res.status(201).json({ ok: true, preset });
  } catch (err: any) {
    res.status(500).json({ error: 'Save preset failed', detail: err?.message });
  }
});

/**
 * DELETE /api/tools/:name?key=<api_key>
 * Removes a stored preset. A built-in whose stored copy is deleted will
 * re-seed on next boot — that's intentional (acts like "reset to default").
 */
toolsRoutes.delete('/:name', requireApiKey, async (req, res) => {
  try {
    const name = req.params.name;
    const { auth, domainId } = await BridgeAuth.getDomainAuth();
    const removed = await ToolLibrary.deletePreset(auth, domainId, name);
    if (!removed) {
      // Not stored on the domain. If it's a built-in, we can't "delete" it
      // because there's nothing on-domain to remove. Tell the caller.
      if (BUILTIN_PRESETS[name]) {
        res.status(409).json({
          error: `"${name}" is a built-in that isn't stored on the domain yet — nothing to delete.`,
        });
        return;
      }
      res.status(404).json({ error: `No preset: ${name}` });
      return;
    }
    res.json({ deleted: true });
  } catch (err: any) {
    res.status(500).json({ error: 'Delete preset failed', detail: err?.message });
  }
});
