import axios from 'axios';
import { BridgeConfig } from './BridgeConfig.js';

const AUKI_API_BASE = (process.env.AUKI_API_BASE_URL || 'https://api.auki.network').replace(/\/+$/, '');
const AUKI_DDS_BASE = (process.env.AUKI_DDS_BASE_URL || 'https://dds.auki.network').replace(/\/+$/, '');

export interface DomainAuth {
  domainToken: string;
  domainServerUrl: string;
  exp?: number;
}

/**
 * Low-level auth helpers (stateless).
 */
export class AukiAuthService {
  static async login(email: string, password: string) {
    const resp = await axios.post(`${AUKI_API_BASE}/user/login`, { email, password }, { timeout: 10_000 });
    const { access_token, refresh_token, expires_in } = resp.data;
    if (!access_token || !refresh_token) throw new Error('Invalid login response');
    return { accessToken: access_token, refreshToken: refresh_token, expiresIn: expires_in ?? 3600 };
  }

  static async mintDomainToken(sessionAccessToken: string, domainId: string): Promise<DomainAuth> {
    const datResp = await axios.post(
      `${AUKI_API_BASE}/service/domains-access-token`,
      {},
      { headers: { Authorization: `Bearer ${sessionAccessToken}` }, timeout: 15_000 },
    );
    const dat = datResp.data?.access_token;
    if (!dat) throw new Error('domains-access-token missing');

    const dAuth = await axios.post(
      `${AUKI_DDS_BASE}/api/v1/domains/${encodeURIComponent(domainId)}/auth`,
      {},
      {
        headers: { Authorization: `Bearer ${dat}`, 'posemesh-client-id': 'shipmemory-bridge' },
        timeout: 15_000,
      },
    );
    const domainToken = dAuth.data?.access_token;
    const domainServerUrl = dAuth.data?.domain_server?.url;
    if (!domainToken || !domainServerUrl) throw new Error('Domain auth missing token or server URL');
    return { domainToken, domainServerUrl, exp: dAuth.data?.exp };
  }
}

/**
 * Server-side cached auth. Reads credentials from BridgeConfig (env > file),
 * logs in on demand, keeps a valid domain token, re-authenticates when the
 * config changes, and wipes state on reset().
 */
export class BridgeAuth {
  private static sessionToken: string | null = null;
  private static domainAuth: DomainAuth | null = null;
  private static domainId: string | null = null;
  private static refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private static mintPromise: Promise<DomainAuth> | null = null;
  private static ensurePromise: Promise<void> | null = null;
  private static subscribed = false;

  /** Called once on boot. Subscribes to config changes. No-op if unconfigured. */
  static async init(): Promise<void> {
    if (!this.subscribed) {
      BridgeConfig.onChange(() => this.handleConfigChange());
      this.subscribed = true;
    }
    await this.handleConfigChange();
  }

  /** Called on boot and whenever BridgeConfig changes. */
  private static async handleConfigChange(): Promise<void> {
    const snapshot = BridgeConfig.current();
    const { aukiEmail, aukiPassword, aukiDomainId } = snapshot;

    if (!aukiEmail || !aukiPassword || !aukiDomainId) {
      // Unconfigured — wipe any cached auth.
      this.reset();
      console.log('[BridgeAuth] Auki credentials not set — waiting for setup');
      return;
    }

    try {
      console.log(`[BridgeAuth] Logging in as ${aukiEmail}...`);
      const { accessToken } = await AukiAuthService.login(aukiEmail, aukiPassword);
      this.sessionToken = accessToken;
      this.domainId = aukiDomainId;
      await this.refresh();
      console.log('[BridgeAuth] Ready');
    } catch (err: any) {
      console.error('[BridgeAuth] Login failed:', err?.message ?? err);
      this.reset();
      throw err;
    }
  }

  /** True iff we hold a live domain token for the current config. */
  static isReady(): boolean {
    const snapshot = BridgeConfig.current();
    if (!snapshot.isConfigured) return false;
    if (!this.domainAuth || !this.sessionToken) return false;
    if (this.domainAuth.exp && this.domainAuth.exp - Date.now() < 10_000) return false;
    return true;
  }

  /** Clear all cached auth state. Cancels any scheduled refresh. */
  static reset(): void {
    this.sessionToken = null;
    this.domainAuth = null;
    this.domainId = null;
    this.mintPromise = null;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  /**
   * Force a fresh login from stored credentials, discarding any cached state.
   * Used by the "Retry Auki login" path when the user wants to recover from a
   * transient upstream failure without restarting the bridge.
   */
  static async relogin(): Promise<void> {
    this.reset();
    await this.ensureReady();
  }

  /**
   * Lazy-login hook for request paths. If auth isn't ready but creds are
   * configured, re-run the login/mint flow. Dedupes concurrent callers so a
   * burst of requests triggers one login, not N.
   */
  static async ensureReady(): Promise<void> {
    if (this.isReady()) return;
    const snapshot = BridgeConfig.current();
    if (!snapshot.isConfigured) {
      throw new Error('Bridge not configured');
    }
    if (this.ensurePromise) return this.ensurePromise;
    this.ensurePromise = (async () => {
      try {
        await this.handleConfigChange();
      } finally {
        this.ensurePromise = null;
      }
    })();
    return this.ensurePromise;
  }

  /** (Re)mint the domain token. Deduplicates concurrent callers via mintPromise. */
  private static async refresh(): Promise<DomainAuth> {
    if (this.mintPromise) return this.mintPromise;
    if (!this.sessionToken || !this.domainId) {
      throw new Error('BridgeAuth not initialized');
    }

    const sessionToken = this.sessionToken;
    const domainId = this.domainId;

    this.mintPromise = (async () => {
      try {
        let activeSession = sessionToken;
        try {
          const auth = await AukiAuthService.mintDomainToken(activeSession, domainId);
          if (this.sessionToken !== sessionToken || this.domainId !== domainId) {
            throw new Error('Config changed during refresh — discarding stale token');
          }
          this.domainAuth = auth;
          this.scheduleRefresh(auth);
          return auth;
        } catch (err: any) {
          // Session access_token likely expired — Auki returns 401/403. Re-login
          // from stored creds and retry once before giving up.
          const status = err?.response?.status;
          if (status !== 401 && status !== 403) throw err;
          const snapshot = BridgeConfig.current();
          if (!snapshot.aukiEmail || !snapshot.aukiPassword) throw err;
          console.log('[BridgeAuth] Session token rejected — re-logging in');
          const { accessToken } = await AukiAuthService.login(snapshot.aukiEmail, snapshot.aukiPassword);
          if (this.domainId !== domainId) {
            throw new Error('Config changed during re-login — discarding stale token');
          }
          this.sessionToken = accessToken;
          activeSession = accessToken;
          const auth = await AukiAuthService.mintDomainToken(activeSession, domainId);
          if (this.domainId !== domainId) {
            throw new Error('Config changed during refresh — discarding stale token');
          }
          this.domainAuth = auth;
          this.scheduleRefresh(auth);
          return auth;
        }
      } finally {
        this.mintPromise = null;
      }
    })();

    return this.mintPromise;
  }

  private static scheduleRefresh(auth: DomainAuth): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (!auth.exp) return;
    const refreshIn = Math.max(60_000, auth.exp - Date.now() - 120_000);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this.refresh().catch((err) => console.error('[BridgeAuth] Refresh failed:', err.message));
    }, refreshIn);
  }

  /** Get a valid domain auth. Refreshes if the cached one is near expiry. */
  static async getDomainAuth(): Promise<{ auth: DomainAuth; domainId: string }> {
    if (!this.domainId || !this.sessionToken) {
      throw new Error('Bridge auth not configured — complete setup at /ui');
    }
    if (this.domainAuth && (!this.domainAuth.exp || this.domainAuth.exp - Date.now() > 60_000)) {
      return { auth: this.domainAuth, domainId: this.domainId };
    }
    const auth = await this.refresh();
    return { auth, domainId: this.domainId };
  }
}
