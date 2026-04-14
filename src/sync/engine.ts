import type { VaultClient } from '../api/vault-client';
import { decryptBlob, encryptBlob } from '../crypto/cipher';
import { ManifestConflictError, type ManifestEntry, type ManifestManager } from './manifest';
import type { ChangeEvent } from './watcher';

export type SyncStatus = 'idle' | 'syncing' | 'error';

/**
 * Subset of Obsidian's Vault the sync engine needs.
 * Declared locally so tests can supply an in-memory double.
 */
export interface SyncVault {
  readBinary(path: string): Promise<ArrayBuffer>;
  exists(path: string): Promise<boolean>;
  create(path: string, data: ArrayBuffer): Promise<void>;
  modify(path: string, data: ArrayBuffer): Promise<void>;
  delete(path: string): Promise<void>;
}

export interface QueueSource {
  getQueue(): ChangeEvent[];
  clearQueue(): void;
}

export interface SyncEngineOpts {
  client: VaultClient;
  manifest: ManifestManager;
  watcher: QueueSource;
  vault: SyncVault;
  masterKey: Uint8Array;
  onStatusChange?: (status: SyncStatus) => void;
  /** Paths known to have been synced on a previous successful sync. Guards against wiping unsynced local work. */
  knownSynced?: Set<string>;
  /** Called after every successful sync with the updated known-synced set so the caller can persist it. */
  onStateUpdate?: (knownSynced: Set<string>) => Promise<void> | void;
}

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Copy a Uint8Array into a fresh ArrayBuffer (needed for BufferSource at API edges). */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  return buf;
}

export class SyncEngine {
  private readonly client: VaultClient;
  private readonly manifest: ManifestManager;
  private readonly watcher: QueueSource;
  private readonly vault: SyncVault;
  private readonly masterKey: Uint8Array;
  private readonly onStatusChange?: (status: SyncStatus) => void;
  private readonly onStateUpdate?: (knownSynced: Set<string>) => Promise<void> | void;
  private knownSynced: Set<string>;

  constructor(opts: SyncEngineOpts) {
    this.client = opts.client;
    this.manifest = opts.manifest;
    this.watcher = opts.watcher;
    this.vault = opts.vault;
    this.masterKey = opts.masterKey;
    this.onStatusChange = opts.onStatusChange;
    this.onStateUpdate = opts.onStateUpdate;
    this.knownSynced = new Set(opts.knownSynced ?? []);
  }

  async sync(): Promise<void> {
    await this.pullChanges();
    await this.pushChanges();
  }

  async pullChanges(): Promise<void> {
    this.emit('syncing');
    try {
      await this.manifest.load();
      const entries = this.manifest.getAllEntries();

      for (const [path, entry] of entries) {
        const localExists = await this.vault.exists(path);
        if (localExists) {
          const local = await this.vault.readBinary(path);
          const localHash = await sha256Hex(local);
          if (localHash === entry.hash) continue;
          const plaintext = await this.downloadAndDecrypt(entry);
          await this.vault.modify(path, plaintext);
        } else {
          const plaintext = await this.downloadAndDecrypt(entry);
          await this.vault.create(path, plaintext);
        }
      }

      for (const path of this.knownSynced) {
        if (!entries.has(path) && (await this.vault.exists(path))) {
          await this.vault.delete(path);
        }
      }

      this.knownSynced = new Set(entries.keys());
      if (this.onStateUpdate) await this.onStateUpdate(new Set(this.knownSynced));
      this.emit('idle');
    } catch (e) {
      this.emit('error');
      throw e;
    }
  }

  private async downloadAndDecrypt(entry: ManifestEntry): Promise<ArrayBuffer> {
    const blob = await this.client.getBlob(entry.blobId);
    const plaintext = await decryptBlob(new Uint8Array(blob), this.masterKey);
    return toArrayBuffer(plaintext);
  }

  async pushChanges(): Promise<void> {
    this.emit('syncing');
    try {
      const events = this.watcher.getQueue();
      if (events.length === 0) {
        this.emit('idle');
        return;
      }

      const pendingSets: Array<[string, ManifestEntry]> = [];
      const pendingDeletes: string[] = [];

      for (const ev of events) {
        if (ev.kind === 'upsert') {
          if (!(await this.vault.exists(ev.path))) continue;

          const plaintext = await this.vault.readBinary(ev.path);
          const hash = await sha256Hex(plaintext);
          const existing = this.manifest.getEntry(ev.path);
          if (existing && existing.hash === hash) continue;

          const blobId = existing?.blobId ?? crypto.randomUUID();
          const encrypted = await encryptBlob(new Uint8Array(plaintext), this.masterKey);
          await this.client.putBlob(blobId, toArrayBuffer(encrypted));

          const entry: ManifestEntry = {
            blobId,
            size: plaintext.byteLength,
            hash,
            modifiedAt: Date.now(),
          };
          this.manifest.setEntry(ev.path, entry);
          pendingSets.push([ev.path, entry]);
        } else if (ev.kind === 'delete') {
          const existing = this.manifest.getEntry(ev.path);
          if (!existing) continue;
          await this.client.deleteBlob(existing.blobId);
          this.manifest.deleteEntry(ev.path);
          pendingDeletes.push(ev.path);
        }
      }

      const mutated = pendingSets.length > 0 || pendingDeletes.length > 0;
      if (mutated) {
        await this.saveWithRetry(pendingSets, pendingDeletes);
      }

      this.watcher.clearQueue();
      this.emit('idle');
    } catch (e) {
      this.emit('error');
      throw e;
    }
  }

  private async saveWithRetry(
    pendingSets: Array<[string, ManifestEntry]>,
    pendingDeletes: string[],
  ): Promise<void> {
    try {
      await this.manifest.save();
    } catch (e) {
      if (!(e instanceof ManifestConflictError)) throw e;

      await this.manifest.load();
      for (const [path, entry] of pendingSets) this.manifest.setEntry(path, entry);
      for (const path of pendingDeletes) this.manifest.deleteEntry(path);
      await this.manifest.save();
    }
  }

  private emit(status: SyncStatus): void {
    this.onStatusChange?.(status);
  }
}
