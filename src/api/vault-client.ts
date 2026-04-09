import { requestUrl } from 'obsidian';
import type {
  VaultTokenRequest,
  VaultTokenResponse,
  VaultStatusResponse,
  ManifestPutResponse,
  BlobUploadResponse,
  BlobDeleteResponse,
  BatchBlobEntry,
  BatchUploadResponse,
  VaultKeyParams,
  VaultKeySetupResponse,
  VaultKeyUpdateResponse,
} from './vault-types';

/**
 * HTTP client for the Silent Stone Vault API (E2E encrypted sync).
 *
 * Uses Obsidian's requestUrl() which bypasses CORS and works on
 * both desktop and mobile. All vault endpoints use Bearer token auth
 * (separate from the session-cookie auth used by the Syncthing API).
 *
 * Binary endpoints (manifest, blobs) exchange raw ArrayBuffers.
 * JSON endpoints exchange typed request/response objects.
 */
export class VaultClient {
  private baseUrl: string;
  private token: string;

  constructor(serverUrl: string, token: string) {
    this.baseUrl = serverUrl.replace(/\/+$/, '');
    this.token = token;
  }

  /** Update the Bearer token (e.g. after re-authentication). */
  setToken(token: string): void {
    this.token = token;
  }

  // ── Auth helpers ───────────────────────────────

  private bearerHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}` };
  }

  private jsonBearerHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json',
    };
  }

  private binaryBearerHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/octet-stream',
    };
  }

  // ── Token ──────────────────────────────────────

  /**
   * Authenticate and receive a vault Bearer token.
   * Public endpoint — no existing token required.
   * Token is valid for 90 days.
   */
  async createToken(req: VaultTokenRequest): Promise<VaultTokenResponse> {
    const resp = await requestUrl({
      url: `${this.baseUrl}/api/vault/token`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
    return resp.json as VaultTokenResponse;
  }

  // ── Status ─────────────────────────────────────

  /** Get vault storage status, quota, and metadata. */
  async getStatus(): Promise<VaultStatusResponse> {
    const resp = await requestUrl({
      url: `${this.baseUrl}/api/vault/status`,
      method: 'GET',
      headers: this.bearerHeaders(),
    });
    return resp.json as VaultStatusResponse;
  }

  // ── Manifest ───────────────────────────────────

  /**
   * Download the encrypted manifest.
   * Returns the raw binary data and the current sequence number.
   * Returns null if no manifest exists (404).
   */
  async getManifest(): Promise<{ data: ArrayBuffer; sequenceNumber: number } | null> {
    try {
      const resp = await requestUrl({
        url: `${this.baseUrl}/api/vault/manifest`,
        method: 'GET',
        headers: this.bearerHeaders(),
      });
      const seq = parseInt(resp.headers['x-sequence-number'] || '0', 10);
      return { data: resp.arrayBuffer, sequenceNumber: seq };
    } catch (e: unknown) {
      if (e && typeof e === 'object' && 'status' in e && (e as { status: number }).status === 404) {
        return null;
      }
      throw e;
    }
  }

  /**
   * Upload an encrypted manifest with optimistic concurrency.
   * The sequenceNumber must match the server's current value or a 409 is returned.
   */
  async putManifest(data: ArrayBuffer, sequenceNumber: number): Promise<ManifestPutResponse> {
    const resp = await requestUrl({
      url: `${this.baseUrl}/api/vault/manifest`,
      method: 'PUT',
      headers: {
        ...this.binaryBearerHeaders(),
        'X-Sequence-Number': String(sequenceNumber),
      },
      body: data,
    });
    return resp.json as ManifestPutResponse;
  }

  // ── Blobs ──────────────────────────────────────

  /**
   * Upload or overwrite a single encrypted blob.
   * Blob ID must be a valid UUID v4.
   */
  async putBlob(id: string, data: ArrayBuffer): Promise<BlobUploadResponse> {
    const resp = await requestUrl({
      url: `${this.baseUrl}/api/vault/blobs/${id}`,
      method: 'PUT',
      headers: this.binaryBearerHeaders(),
      body: data,
    });
    return resp.json as BlobUploadResponse;
  }

  /**
   * Download an encrypted blob by ID.
   * Returns the raw binary data.
   */
  async getBlob(id: string): Promise<ArrayBuffer> {
    const resp = await requestUrl({
      url: `${this.baseUrl}/api/vault/blobs/${id}`,
      method: 'GET',
      headers: this.bearerHeaders(),
    });
    return resp.arrayBuffer;
  }

  /** Delete an encrypted blob by ID. */
  async deleteBlob(id: string): Promise<BlobDeleteResponse> {
    const resp = await requestUrl({
      url: `${this.baseUrl}/api/vault/blobs/${id}`,
      method: 'DELETE',
      headers: this.jsonBearerHeaders(),
    });
    return resp.json as BlobDeleteResponse;
  }

  /**
   * Upload multiple blobs in a single atomic request.
   * Each blob's data must be Base64-encoded. Max 50 blobs per batch.
   * Entire batch is rejected if total would exceed storage quota.
   */
  async batchUpload(blobs: BatchBlobEntry[]): Promise<BatchUploadResponse> {
    const resp = await requestUrl({
      url: `${this.baseUrl}/api/vault/blobs/batch`,
      method: 'POST',
      headers: this.jsonBearerHeaders(),
      body: JSON.stringify({ blobs }),
    });
    return resp.json as BatchUploadResponse;
  }

  // ── Keys ───────────────────────────────────────

  /**
   * First-time setup: register the encrypted master key and Argon2 parameters.
   * Returns 409 if keys already exist (use updateKeys instead).
   */
  async setupKeys(params: VaultKeyParams): Promise<VaultKeySetupResponse> {
    const resp = await requestUrl({
      url: `${this.baseUrl}/api/vault/keys/setup`,
      method: 'POST',
      headers: this.jsonBearerHeaders(),
      body: JSON.stringify(params),
    });
    return resp.json as VaultKeySetupResponse;
  }

  /**
   * Retrieve the encrypted master key and Argon2 derivation parameters.
   * Returns null if keys haven't been configured yet (404).
   */
  async getKeys(): Promise<VaultKeyParams | null> {
    try {
      const resp = await requestUrl({
        url: `${this.baseUrl}/api/vault/keys`,
        method: 'GET',
        headers: this.bearerHeaders(),
      });
      return resp.json as VaultKeyParams;
    } catch (e: unknown) {
      if (e && typeof e === 'object' && 'status' in e && (e as { status: number }).status === 404) {
        return null;
      }
      throw e;
    }
  }

  /**
   * Update the encrypted master key (password change or recovery).
   * Returns 404 if keys haven't been set up yet (use setupKeys first).
   */
  async updateKeys(params: VaultKeyParams): Promise<VaultKeyUpdateResponse> {
    const resp = await requestUrl({
      url: `${this.baseUrl}/api/vault/keys`,
      method: 'PUT',
      headers: this.jsonBearerHeaders(),
      body: JSON.stringify(params),
    });
    return resp.json as VaultKeyUpdateResponse;
  }

  // ── Health ─────────────────────────────────────

  /** Check if the server is reachable (public, no auth). */
  async health(): Promise<boolean> {
    try {
      const resp = await requestUrl({
        url: `${this.baseUrl}/api/health`,
        method: 'GET',
      });
      return resp.status === 200;
    } catch {
      return false;
    }
  }
}
