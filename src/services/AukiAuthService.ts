import axios from 'axios';

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
 * Server-side cached auth. The bridge logs in once with its own credentials
 * and keeps a valid domain token for all public endpoints (e.g. /resolve).
 */
export class BridgeAuth {
  private static sessionToken: string | null = null;
  private static domainAuth: DomainAuth | null = null;
  private static domainId: string | null = null;
  private static mintPromise: Promise<DomainAuth> | null = null;

  static async init() {
    const email = process.env.AUKI_EMAIL;
    const password = process.env.AUKI_PASSWORD;
    const domainId = process.env.AUKI_DOMAIN_ID;
    if (!email || !password || !domainId) {
      console.warn('WARN: AUKI_EMAIL, AUKI_PASSWORD, or AUKI_DOMAIN_ID not set — bridge auth disabled');
      return;
    }
    this.domainId = domainId;
    console.log(`[BridgeAuth] Logging in as ${email}...`);
    const { accessToken } = await AukiAuthService.login(email, password);
    this.sessionToken = accessToken;
    await this.refreshDomainToken();
    console.log('[BridgeAuth] Ready');
  }

  private static async refreshDomainToken(): Promise<DomainAuth> {
    if (!this.sessionToken || !this.domainId) throw new Error('Bridge auth not initialized');
    // Deduplicate concurrent refreshes
    if (this.mintPromise) return this.mintPromise;
    this.mintPromise = (async () => {
      const auth = await AukiAuthService.mintDomainToken(this.sessionToken!, this.domainId!);
      this.domainAuth = auth;
      // Schedule refresh before expiry
      if (auth.exp) {
        const refreshIn = Math.max(60_000, auth.exp - Date.now() - 120_000);
        setTimeout(() => {
          this.mintPromise = null;
          this.refreshDomainToken().catch(err => console.error('[BridgeAuth] Refresh failed:', err.message));
        }, refreshIn);
      }
      return auth;
    })();
    try {
      return await this.mintPromise;
    } finally {
      this.mintPromise = null;
    }
  }

  /** Get a valid domain auth for server-side reads/writes */
  static async getDomainAuth(): Promise<{ auth: DomainAuth; domainId: string }> {
    if (!this.domainId) throw new Error('Bridge auth not configured (set AUKI_EMAIL, AUKI_PASSWORD, AUKI_DOMAIN_ID)');
    if (this.domainAuth && (!this.domainAuth.exp || this.domainAuth.exp - Date.now() > 60_000)) {
      return { auth: this.domainAuth, domainId: this.domainId };
    }
    const auth = await this.refreshDomainToken();
    return { auth, domainId: this.domainId };
  }
}
