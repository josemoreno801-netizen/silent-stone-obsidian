import type { VaultClient } from '../api/vault-client';
import { decryptBlob, encryptBlob } from '../crypto/cipher';

/** One row in the manifest — everything needed to map a vault path to its encrypted blob. */
export interface ManifestEntry {
  /** UUID v4 identifying the encrypted blob on the server. */
  blobId: string;
  /** Plaintext size in bytes, for quota accounting and change heuristics. */
  size: number;
  /** SHA-256 of the plaintext (hex). Primary change-detection signal. */
  hash: string;
  /** Unix millis — tiebreaker when hash is missing or untrusted. */
  modifiedAt: number;
}

/** Decrypted manifest shape. Version gates future schema migrations. */
export interface Manifest {
  version: 1;
  entries: Record<string, ManifestEntry>;
}

/**
 * Thrown by {@link ManifestManager.save} when the server's sequence number has moved
 * past the client's — another device saved a manifest since this client loaded. The
 * caller must reload, re-diff, and retry.
 */
export class ManifestConflictError extends Error {
  constructor(
    public readonly serverSequence: number,
    public readonly clientSequence: number,
  ) {
    super(
      `Manifest sequence conflict: server=${serverSequence} client=${clientSequence}`,
    );
    this.name = 'ManifestConflictError';
  }
}

/**
 * In-memory cache of the encrypted manifest, plus load/save plumbing.
 *
 * Exists so the sync engine's upload and download paths share one source of truth
 * for path→blob mappings and for optimistic-concurrency sequence tracking.
 */
export class ManifestManager {
  private entries: Map<string, ManifestEntry> = new Map();
  private seq = 0;

  constructor(
    private readonly client: VaultClient,
    private readonly masterKey: Uint8Array,
  ) {}

  get sequenceNumber(): number {
    return this.seq;
  }

  async load(): Promise<void> {
    const resp = await this.client.getManifest();
    if (resp === null) {
      this.entries = new Map();
      this.seq = 0;
      return;
    }
    const plaintext = await decryptBlob(new Uint8Array(resp.data), this.masterKey);
    const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as Manifest;
    this.entries = new Map(Object.entries(parsed.entries ?? {}));
    this.seq = resp.sequenceNumber;
  }

  async save(): Promise<void> {
    const plaintext = new TextEncoder().encode(this.serialize());
    const encrypted = await encryptBlob(plaintext, this.masterKey);
    const buf = new ArrayBuffer(encrypted.byteLength);
    new Uint8Array(buf).set(encrypted);

    try {
      const resp = await this.client.putManifest(buf, this.seq);
      this.seq = resp.sequenceNumber;
    } catch (e: unknown) {
      if (e && typeof e === 'object' && 'status' in e && (e as { status: number }).status === 409) {
        const body = (e as { json?: { serverSequence?: number; clientSequence?: number } }).json;
        throw new ManifestConflictError(
          body?.serverSequence ?? -1,
          body?.clientSequence ?? this.seq,
        );
      }
      throw e;
    }
  }

  getEntry(path: string): ManifestEntry | undefined {
    return this.entries.get(path);
  }

  setEntry(path: string, entry: ManifestEntry): void {
    this.entries.set(path, entry);
  }

  deleteEntry(path: string): void {
    this.entries.delete(path);
  }

  getAllEntries(): Map<string, ManifestEntry> {
    return new Map(this.entries);
  }

  /**
   * Compute changeset relative to the current manifest.
   *
   * @param localFiles Map of vault-relative path -> SHA-256 hex of plaintext.
   * @returns Paths whose content differs from the manifest (toUpload) and paths
   *          present in the manifest but missing locally (toDelete).
   */
  diff(localFiles: Map<string, string>): { toUpload: string[]; toDelete: string[] } {
    const toUpload: string[] = [];
    const toDelete: string[] = [];

    for (const [path, localHash] of localFiles) {
      const entry = this.entries.get(path);
      if (!entry || entry.hash !== localHash) toUpload.push(path);
    }
    for (const path of this.entries.keys()) {
      if (!localFiles.has(path)) toDelete.push(path);
    }

    return { toUpload, toDelete };
  }

  private serialize(): string {
    const manifest: Manifest = {
      version: 1,
      entries: Object.fromEntries(this.entries),
    };
    return JSON.stringify(manifest);
  }
}
