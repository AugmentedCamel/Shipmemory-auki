import axios from 'axios';
import crypto from 'crypto';
import type { DomainAuth } from './AukiAuthService.js';

/**
 * Stateless domain CRUD. Every call requires a DomainAuth and domainId
 * — the bridge never caches tokens server-side.
 */
export class DomainStorageService {
  static async store(
    auth: DomainAuth,
    domainId: string,
    payload: Buffer | string,
    opts: { name?: string; dataType: string; contentType: string },
  ): Promise<string> {
    const boundary = `----SM${Date.now()}`;
    const uniqueName = opts.name || `${opts.dataType}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const disposition = `Content-Disposition: form-data; name="${uniqueName}"; data-type="${opts.dataType}"`;
    const header = `--${boundary}\r\n${disposition}\r\nContent-Type: ${opts.contentType}\r\n\r\n`;
    const footer = `\r\n--${boundary}--\r\n`;
    const body = Buffer.concat([Buffer.from(header), Buffer.isBuffer(payload) ? payload : Buffer.from(payload), Buffer.from(footer)]);

    const resp = await axios.post(
      `${auth.domainServerUrl}/api/v1/domains/${encodeURIComponent(domainId)}/data`,
      body,
      {
        headers: {
          Authorization: `Bearer ${auth.domainToken}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'posemesh-client-id': 'shipmemory-bridge',
        },
        timeout: 30_000,
        maxBodyLength: Infinity,
      },
    );

    const dataId = resp.data?.id || resp.data?.data?.[0]?.id;
    if (!dataId) throw new Error('Domain store returned no dataId');
    return dataId;
  }

  static async load(auth: DomainAuth, domainId: string, dataId: string): Promise<{ buffer: Buffer; contentType: string }> {
    const resp = await axios.get(
      `${auth.domainServerUrl}/api/v1/domains/${encodeURIComponent(domainId)}/data/${encodeURIComponent(dataId)}`,
      {
        params: { raw: 1 },
        headers: {
          Authorization: `Bearer ${auth.domainToken}`,
          'posemesh-client-id': 'shipmemory-bridge',
        },
        responseType: 'arraybuffer',
        timeout: 15_000,
      },
    );
    return { buffer: Buffer.from(resp.data), contentType: resp.headers['content-type'] || 'application/octet-stream' };
  }

  static async listByType(auth: DomainAuth, domainId: string, dataType: string): Promise<any[]> {
    const resp = await axios.get(
      `${auth.domainServerUrl}/api/v1/domains/${encodeURIComponent(domainId)}/data`,
      {
        params: { data_type: dataType },
        headers: {
          Authorization: `Bearer ${auth.domainToken}`,
          'posemesh-client-id': 'shipmemory-bridge',
        },
        timeout: 15_000,
      },
    );
    const raw = resp.data;
    return Array.isArray(raw?.data) ? raw.data : Array.isArray(raw) ? raw : raw?.items || [];
  }

  static async delete(auth: DomainAuth, domainId: string, dataId: string): Promise<void> {
    await axios.delete(
      `${auth.domainServerUrl}/api/v1/domains/${encodeURIComponent(domainId)}/data/${encodeURIComponent(dataId)}`,
      {
        headers: {
          Authorization: `Bearer ${auth.domainToken}`,
          'posemesh-client-id': 'shipmemory-bridge',
        },
        timeout: 15_000,
      },
    );
  }
}
