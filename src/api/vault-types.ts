/**
 * API types for the Silent Stone Vault API (E2E encrypted sync).
 * Source of truth: src/lib/vault/ in the server codebase.
 *
 * Separate from types.ts which covers the Syncthing folder API.
 */

// ── Token ──────────────────────────────────────

export interface VaultTokenRequest {
  nickname: string;
  password: string;
  label?: string;
}

export interface VaultTokenResponse {
  token: string;
  nickname: string;
  expiresAt: number;
  label: string;
}

// ── Status ─────────────────────────────────────

export interface VaultStatusResponse {
  storageUsedBytes: number;
  storageLimitBytes: number;
  tier: string;
  lastSyncAt: string | null;
  manifestSeq: number;
  keysConfigured: boolean;
  suspended: boolean;
}

// ── Manifest ───────────────────────────────────

export interface ManifestPutResponse {
  ok: true;
  sequenceNumber: number;
}

export interface ManifestConflictError {
  error: 'Manifest sequence conflict';
  serverSequence: number;
  clientSequence: number;
}

// ── Blobs ──────────────────────────────────────

export interface BlobUploadResponse {
  ok: true;
  blobId: string;
  size: number;
}

export interface BlobDeleteResponse {
  ok: true;
}

export interface BatchBlobEntry {
  id: string;
  data: string; // Base64-encoded encrypted blob
}

export interface BatchUploadResponse {
  ok: true;
  uploaded: string[];
  totalSize: number;
}

// ── Keys ───────────────────────────────────────

export interface VaultKeyParams {
  encryptedMasterKey: string;
  salt: string;
  argon2Memory: number;
  argon2Time: number;
  argon2Parallelism: number;
}

export interface VaultKeySetupResponse {
  ok: true;
}

export interface VaultKeyUpdateResponse {
  ok: true;
}

// ── Errors ─────────────────────────────────────

export interface VaultQuotaError {
  error: string;
  storageUsedBytes?: number;
  storageLimitBytes?: number;
}

export interface VaultApiError {
  error: string;
}
