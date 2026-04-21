import type { DomainAuth } from './AukiAuthService.js';
import { BridgeAuth } from './AukiAuthService.js';
import { DomainStorageService } from './DomainStorageService.js';
import { TOOL_PRESET_TYPE } from './DomainLayout.js';

/**
 * A tool preset lives on the Auki domain under data_type `tool_preset`.
 * One preset = one tool the agent can be given. The preset stores the
 * definition the agent sees (name, description, parameters) plus either:
 *   - `builtin` — identifier the bridge dispatches internally, or
 *   - `execute_url` — custom endpoint we'd forward to (custom tools,
 *     not yet implemented on the bridge side; developers can still
 *     reference them and run their own dispatcher).
 */
export type ToolPreset = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  builtin?: string;
  execute_url?: string;
};

type DomainItem = { id?: string; data_id?: string; name?: string };
const idOf = (i: DomainItem) => i.id || i.data_id;

export const BUILTIN_SESSION_HISTORY: ToolPreset = {
  name: 'session_history',
  description:
    "Save or recall the running log of this session. Call with action='append' after every meaningful exchange — even if the session ends unexpectedly, everything already appended is durable on the user's Auki Domain. Call with action='read' when you need to recall earlier turns.",
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['append', 'read'],
        description: "'append' to store a turn. 'read' to fetch earlier turns.",
      },
      session_id: {
        type: 'string',
        description: 'Identifier for this conversation. Required for append; filters results for read.',
      },
      question: {
        type: 'string',
        description: "The user's input for this turn (required for append).",
      },
      response: {
        type: 'string',
        description: 'Your reply for this turn (required for append).',
      },
      notes: {
        type: 'string',
        description: 'Optional short summary or fact worth carrying forward.',
      },
      limit: {
        type: 'integer',
        description: 'Max number of entries to return (read only; default 20).',
      },
    },
    required: ['action'],
  },
  builtin: 'session_history',
};

export const BUILTIN_PRESETS: Record<string, ToolPreset> = {
  [BUILTIN_SESSION_HISTORY.name]: BUILTIN_SESSION_HISTORY,
};

async function loadPresetByName(
  auth: DomainAuth,
  domainId: string,
  name: string,
): Promise<{ data_id: string; preset: ToolPreset } | null> {
  const items = await DomainStorageService.listByType(auth, domainId, TOOL_PRESET_TYPE);
  const hit = items.find((i: DomainItem) => i.name === name);
  if (!hit) return null;
  const id = idOf(hit);
  if (!id) return null;
  try {
    const raw = await DomainStorageService.load(auth, domainId, id);
    const parsed = JSON.parse(raw.buffer.toString('utf-8')) as ToolPreset;
    return { data_id: id, preset: parsed };
  } catch {
    return null;
  }
}

export const ToolLibrary = {
  /**
   * Resolve a preset by name. Prefers a domain-stored preset (so operators
   * can override built-ins), falls back to the hardcoded built-in, returns
   * null if neither exists.
   */
  async getPreset(auth: DomainAuth, domainId: string, name: string): Promise<ToolPreset | null> {
    const stored = await loadPresetByName(auth, domainId, name);
    if (stored) return stored.preset;
    return BUILTIN_PRESETS[name] ?? null;
  },

  /**
   * List every preset visible to the UI. Domain entries win over built-ins
   * of the same name; built-ins that aren't stored yet are surfaced as
   * virtual entries so the user still sees them.
   */
  async list(auth: DomainAuth, domainId: string): Promise<Array<ToolPreset & { stored: boolean }>> {
    const items = await DomainStorageService.listByType(auth, domainId, TOOL_PRESET_TYPE);
    const stored: Array<ToolPreset & { stored: boolean }> = [];
    const seenNames = new Set<string>();
    for (const item of items) {
      const id = idOf(item);
      if (!id) continue;
      try {
        const raw = await DomainStorageService.load(auth, domainId, id);
        const preset = JSON.parse(raw.buffer.toString('utf-8')) as ToolPreset;
        if (preset.name) {
          stored.push({ ...preset, stored: true });
          seenNames.add(preset.name);
        }
      } catch {
        // skip broken entries
      }
    }
    for (const name of Object.keys(BUILTIN_PRESETS)) {
      if (!seenNames.has(name)) stored.push({ ...BUILTIN_PRESETS[name], stored: false });
    }
    return stored;
  },

  /**
   * Save (create or overwrite) a preset. If a preset with this name already
   * exists on the domain, the old entry is deleted first — the Auki domain
   * requires domain-wide unique names, so overwrite = delete + store.
   */
  async savePreset(auth: DomainAuth, domainId: string, preset: ToolPreset): Promise<void> {
    if (!preset.name || typeof preset.name !== 'string') throw new Error('preset.name required');
    const items = await DomainStorageService.listByType(auth, domainId, TOOL_PRESET_TYPE);
    const existing = items.find((i: DomainItem) => i.name === preset.name);
    if (existing && idOf(existing)) {
      try {
        await DomainStorageService.delete(auth, domainId, idOf(existing)!);
      } catch (err: any) {
        throw new Error(`Could not replace preset "${preset.name}": ${err?.message}`);
      }
    }
    await DomainStorageService.store(auth, domainId, JSON.stringify(preset), {
      name: preset.name,
      dataType: TOOL_PRESET_TYPE,
      contentType: 'application/json',
    });
  },

  /**
   * Delete a preset by name. Returns true if a stored entry was removed,
   * false if no such entry was on the domain (built-ins that were never
   * persisted fall into this case — nothing to delete).
   */
  async deletePreset(auth: DomainAuth, domainId: string, name: string): Promise<boolean> {
    const items = await DomainStorageService.listByType(auth, domainId, TOOL_PRESET_TYPE);
    const existing = items.find((i: DomainItem) => i.name === name);
    if (!existing || !idOf(existing)) return false;
    await DomainStorageService.delete(auth, domainId, idOf(existing)!);
    return true;
  },

  /**
   * Idempotently write built-in presets to the domain. Safe to call on every
   * boot — it only writes presets whose names don't already exist.
   * No-op when auth isn't ready yet.
   */
  async seed(): Promise<void> {
    if (!BridgeAuth.isReady()) return;
    const { auth, domainId } = await BridgeAuth.getDomainAuth();
    const items = await DomainStorageService.listByType(auth, domainId, TOOL_PRESET_TYPE);
    const existingNames = new Set(items.map((i: DomainItem) => i.name).filter((n): n is string => !!n));

    for (const [name, preset] of Object.entries(BUILTIN_PRESETS)) {
      if (existingNames.has(name)) continue;
      try {
        await DomainStorageService.store(auth, domainId, JSON.stringify(preset), {
          name,
          dataType: TOOL_PRESET_TYPE,
          contentType: 'application/json',
        });
        console.log(`[ToolLibrary] Seeded built-in preset "${name}"`);
      } catch (err: any) {
        console.warn(`[ToolLibrary] Failed to seed "${name}":`, err?.message);
      }
    }
  },
};
