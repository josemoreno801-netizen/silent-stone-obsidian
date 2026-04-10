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

  /**
   * Create a new VaultClient.
   *
   * @param serverUrl Base URL of the Silent Stone server (e.g. `https://silentstone.one`).
   *                  Any trailing slashes are stripped so per-endpoint paths can be appended directly.
   * @param token     Bearer token from {@link createToken}. Sent on every authenticated request.
   */
  constructor(serverUrl: string, token: string) {
    this.baseUrl = serverUrl.replace(/\/+$/, '');
    this.token = token;
  }

  /**
   * Replace the stored Bearer token in place.
   *
   * Used when a token expires mid-session and a new one is minted via {@link createToken}
   * without recreating the client.
   *
   * @param token New Bearer token from a fresh `POST /api/vault/token` call.
   */
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
   * Authenticate with nickname + password and receive a vault Bearer token.
   *
   * Public endpoint — no existing token required. The returned token is valid for 90 days
   * and should be persisted via Obsidian's `SecretComponent`. Content-Type is set to
   * `application/json` (required by Caddy — bodiless mutations get 403 without it).
   *
   * @param req Login payload: `{ nickname, password, label }`. The `label` is a human-readable
   *            device identifier stored alongside the token hash for admin audit.
   * @returns Token response including the raw token (shown to client exactly once) and expiry.
   * @throws When credentials are invalid, account is pending approval, or rate limit exceeded.
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

  /**
   * Get the authenticated user's vault storage status.
   *
   * @returns `{ storageUsedBytes, storageLimitBytes, tier, manifestSequence, lastSyncAt, ... }`.
   *          Safe to call frequently — used by the status bar poller to show quota usage.
   * @throws On 401 if the Bearer token is invalid/expired, or 403 if the vault is suspended.
   */
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
   * Download the encrypted manifest and the server's current sequence number.
   *
   * The returned `data` is a raw `ArrayBuffer` produced by the plugin's `encryptBlob()`
   * with this exact byte structure:
   *
   *     nonce (12 bytes) || ciphertext || AES-GCM auth tag (16 bytes)
   *
   * Pass it to `decryptBlob(data, masterKey)` to recover the JSON manifest. The caller
   * should store the `sequenceNumber` and echo it on the next {@link putManifest} call
   * to enforce optimistic concurrency.
   *
   * @returns `{ data, sequenceNumber }` on success, or `null` when the server returns 404
   *          (no manifest exists yet — first-time setup).
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
   * Upload an encrypted manifest with optimistic concurrency control.
   *
   * The `data` buffer must be the output of `encryptBlob(plaintext, masterKey)` — raw bytes
   * laid out as `nonce (12B) || ciphertext || auth tag (16B)`. The server does not parse or
   * validate the contents; it only writes them and bumps its stored sequence counter.
   *
   * Content-Type is `application/octet-stream` (required to bypass Caddy's CSRF filter on
   * binary PUTs). The `X-Sequence-Number` header MUST match the server's current value or
   * the server returns 409 Conflict with both numbers in the body so the caller can re-sync.
   *
   * @param data           Encrypted manifest as a raw ArrayBuffer.
   * @param sequenceNumber The sequence number the caller last observed via {@link getManifest}.
   * @returns New sequence number after write.
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
   * Upload or overwrite a single encrypted blob at the given UUID.
   *
   * The `data` buffer is the raw output of `encryptBlob(plaintext, masterKey)` — structure:
   * `nonce (12B) || ciphertext || auth tag (16B)`. Content-Type is `application/octet-stream`
   * (required to bypass Caddy's CSRF filter on binary PUTs).
   *
   * @param id   UUID v4 string identifying the blob. Must match `^[0-9a-f-]{36}$`.
   * @param data Encrypted payload as a raw ArrayBuffer.
   * @throws 413 Payload Too Large if the upload would push the user past their quota.
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
   * Download an encrypted blob by its UUID.
   *
   * Returns the raw ciphertext bytes as an `ArrayBuffer`. Structure:
   * `nonce (12 bytes) || ciphertext || auth tag (16 bytes)`. Pass to `decryptBlob()`
   * with the master key to recover the plaintext.
   *
   * @param id UUID v4 string identifying the blob.
   * @throws 404 if the blob does not exist, 401 if the token is invalid.
   */
  async getBlob(id: string): Promise<ArrayBuffer> {
    const resp = await requestUrl({
      url: `${this.baseUrl}/api/vault/blobs/${id}`,
      method: 'GET',
      headers: this.bearerHeaders(),
    });
    return resp.arrayBuffer;
  }

  /**
   * Delete an encrypted blob by its UUID.
   *
   * Content-Type is explicitly `application/json` on this bodiless DELETE — required to
   * bypass Caddy's CSRF filter, which rejects bodiless mutations with 403 when no
   * Content-Type header is present (same workaround as the v0.2 logout fix).
   *
   * @param id UUID v4 string identifying the blob.
   */
  async deleteBlob(id: string): Promise<BlobDeleteResponse> {
    const resp = await requestUrl({
      url: `${this.baseUrl}/api/vault/blobs/${id}`,
      method: 'DELETE',
      headers: this.jsonBearerHeaders(),
    });
    return resp.json as BlobDeleteResponse;
  }

  /**
   * Upload multiple encrypted blobs in a single atomic request.
   *
   * Each entry's `data` must be the **base64-encoded** output of `encryptBlob()` — the
   * batch endpoint takes JSON rather than raw binary so multiple blobs can be bundled.
   * Content-Type is `application/json`. Max 50 blobs per call. The entire batch is
   * rejected with 413 if the combined size would push the user past their quota —
   * no partial writes.
   *
   * @param blobs Array of `{ id, data }` entries. `id` is a UUID v4; `data` is base64.
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
   * First-time registration of the encrypted master key and Argon2 parameters.
   *
   * Call this exactly once per vault, immediately after the user generates their master
   * key and recovery phrase. Content-Type is `application/json`.
   *
   * @param params Output of `wrapMasterKey()` — `{ encryptedMasterKey, salt, argon2Params }`.
   * @throws 409 Conflict if keys already exist for this user — call {@link updateKeys} instead.
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
   *
   * The returned blob is meaningless to anyone without the user's password — the server
   * stores only the ciphertext. Pass the result to `unwrapMasterKey({ ...params, password })`
   * in the plugin's crypto module to recover the 256-bit master key.
   *
   * @returns `{ encryptedMasterKey, salt, argon2Params }` on success, or `null` on 404
   *          (keys have not been set up — call {@link setupKeys} first).
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
   * Re-wrap the master key with a new password (password change or recovery flow).
   *
   * Called after the user enters a new password — the caller first unwraps the master key
   * with the old password or recovery phrase, then calls `wrapMasterKey()` with the new
   * password, then sends the fresh `VaultKeyParams` here. Content-Type is `application/json`.
   *
   * @param params Output of a fresh `wrapMasterKey()` call.
   * @throws 404 Not Found if keys have not been set up yet — use {@link setupKeys} instead.
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

  /**
   * Check if the server is reachable.
   *
   * Public endpoint — no Bearer token required. Used by the settings tab "Test connection"
   * button to verify the `serverUrl` is reachable before the user tries to log in.
   *
   * @returns `true` on HTTP 200, `false` on any network error, DNS failure, or non-200 response.
   */
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
