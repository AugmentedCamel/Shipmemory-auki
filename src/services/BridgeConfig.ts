import { promises as fs } from 'fs';
import path from 'path';

/**
 * Single source of truth for bridge-level credentials.
 *
 * Resolution order per field:
 *   1. process.env.<VAR>  (prod path — Railway/docker env)
 *   2. data/config.json   (local / UI-driven path)
 *   3. null               (unconfigured)
 *
 * Writes only ever touch data/config.json — env vars are never rewritten.
 * Env wins over file, so anything set in Railway's dashboard keeps winning
 * even if a stale config.json hangs around.
 */

export interface BridgeConfigSnapshot {
  aukiEmail: string | null;
  aukiPassword: string | null;
  aukiDomainId: string | null;
  apiKey: string | null;
  /** Fields whose current value came from process.env (and thus can't be changed via UI). */
  envOverrides: ReadonlyArray<keyof Pick<BridgeConfigSnapshot, 'aukiEmail' | 'aukiPassword' | 'aukiDomainId' | 'apiKey'>>;
  /** True iff all four credential fields resolve to non-empty values. */
  isConfigured: boolean;
}

interface FileConfig {
  aukiEmail?: string | null;
  aukiPassword?: string | null;
  aukiDomainId?: string | null;
  apiKey?: string | null;
}

type Listener = (snapshot: BridgeConfigSnapshot) => void | Promise<void>;

const DATA_DIR = path.resolve(process.cwd(), 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

function nonEmpty(v: string | undefined | null): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export class BridgeConfig {
  private static fileState: FileConfig = {};
  private static listeners: Listener[] = [];
  private static loaded = false;

  /** Called once on boot. Reads data/config.json (if present) into memory. */
  static async load(): Promise<void> {
    try {
      const raw = await fs.readFile(CONFIG_PATH, 'utf-8');
      const parsed = JSON.parse(raw);
      this.fileState = {
        aukiEmail: nonEmpty(parsed.aukiEmail),
        aukiPassword: nonEmpty(parsed.aukiPassword),
        aukiDomainId: nonEmpty(parsed.aukiDomainId),
        apiKey: nonEmpty(parsed.apiKey),
      };
      console.log('[BridgeConfig] Loaded config from data/config.json');
    } catch (err: any) {
      if (err.code !== 'ENOENT') {
        console.warn('[BridgeConfig] Could not read data/config.json:', err.message);
      }
      this.fileState = {};
    }
    this.loaded = true;
  }

  /** In-memory snapshot. Safe to call per-request. */
  static current(): BridgeConfigSnapshot {
    const envEmail = nonEmpty(process.env.AUKI_EMAIL);
    const envPassword = nonEmpty(process.env.AUKI_PASSWORD);
    const envDomainId = nonEmpty(process.env.AUKI_DOMAIN_ID);
    const envApiKey = nonEmpty(process.env.API_KEY);

    const aukiEmail = envEmail ?? this.fileState.aukiEmail ?? null;
    const aukiPassword = envPassword ?? this.fileState.aukiPassword ?? null;
    const aukiDomainId = envDomainId ?? this.fileState.aukiDomainId ?? null;
    const apiKey = envApiKey ?? this.fileState.apiKey ?? null;

    const envOverrides: BridgeConfigSnapshot['envOverrides'] = [
      ...(envEmail ? ['aukiEmail' as const] : []),
      ...(envPassword ? ['aukiPassword' as const] : []),
      ...(envDomainId ? ['aukiDomainId' as const] : []),
      ...(envApiKey ? ['apiKey' as const] : []),
    ];

    return {
      aukiEmail,
      aukiPassword,
      aukiDomainId,
      apiKey,
      envOverrides,
      isConfigured: !!(aukiEmail && aukiPassword && aukiDomainId && apiKey),
    };
  }

  /** Persist + notify. Skips fields that are env-overridden (can't be changed). */
  static async setAuki(email: string, password: string, domainId: string): Promise<void> {
    this.fileState = {
      ...this.fileState,
      aukiEmail: nonEmpty(email),
      aukiPassword: nonEmpty(password),
      aukiDomainId: nonEmpty(domainId),
    };
    await this.flush();
    await this.notify();
  }

  static async setApiKey(newKey: string): Promise<void> {
    this.fileState = { ...this.fileState, apiKey: nonEmpty(newKey) };
    await this.flush();
    await this.notify();
  }

  /** Logout — clears Auki creds in the file. API key stays. */
  static async clearAuki(): Promise<void> {
    this.fileState = {
      ...this.fileState,
      aukiEmail: null,
      aukiPassword: null,
      aukiDomainId: null,
    };
    await this.flush();
    await this.notify();
  }

  /** Subscribe to config changes (e.g. BridgeAuth re-init). */
  static onChange(listener: Listener): void {
    this.listeners.push(listener);
  }

  private static async notify(): Promise<void> {
    const snapshot = this.current();
    for (const listener of this.listeners) {
      try {
        await listener(snapshot);
      } catch (err: any) {
        console.error('[BridgeConfig] Listener failed:', err.message);
      }
    }
  }

  /** Atomic write: tmp + rename. */
  private static async flush(): Promise<void> {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const payload = JSON.stringify(this.fileState, null, 2);
    const tmp = CONFIG_PATH + '.tmp';
    await fs.writeFile(tmp, payload, { mode: 0o600 });
    await fs.rename(tmp, CONFIG_PATH);
  }
}
