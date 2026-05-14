import type { VaultClient } from '../api/vault-client';
import { decryptBlob, encryptBlob } from '../crypto/cipher';
import { ManifestConflictError, type ManifestEntry, type ManifestManager } from './manifest';
import type { SyncStatusEvent } from '../types';
import type { ChangeEvent } from './watcher';

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
  /** Vault-relative paths of every syncable file currently on disk. */
  listAll(): Promise<string[]>;
}

export interface QueueSource {
  getQueue(): ChangeEvent[];
  clearQueue(): void;
}

export type ConflictResolution = 'keep-local' | 'keep-server' | 'keep-both';

export interface ConflictInfo {
  path: string;
  localHash: string;
  serverHash: string;
  /** Hash on disk the last time this file was successfully synced. Empty string when migrating from the legacy paths-only persisted shape (no reliable history). */
  lastKnownHash: string;
  localContent: ArrayBuffer;
  serverContent: ArrayBuffer;
  /** Manifest entry's modifiedAt for the server side. */
  serverModifiedAt: number;
}

export type ConflictHandler = (info: ConflictInfo) => Promise<ConflictResolution> | ConflictResolution;

export interface SyncEngineOpts {
  client: VaultClient;
  manifest: ManifestManager;
  watcher: QueueSource;
  vault: SyncVault;
  masterKey: Uint8Array;
  onStatusChange?: (event: SyncStatusEvent) => void;
  /**
   * Last-known plaintext hash per synced path. Lets the engine distinguish a real
   * divergence (both sides changed since last sync) from a one-sided change.
   * Empty-string values are migration sentinels (legacy state had paths only, no
   * hashes); the engine treats them as "preserve local, record the actual hash
   * next round" so an upgrade can't false-positive into a conflict storm.
   */
  knownSynced?: Map<string, string>;
  /** Called after every successful sync with the updated known-synced map so the caller can persist it. */
  onStateUpdate?: (knownSynced: Map<string, string>) => Promise<void> | void;
  /**
   * Called when a real divergence is detected (local and server both changed since
   * last known sync). Resolution drives what the engine does with the file. If not
   * provided, the engine defaults to 'keep-server' with a console warning — same
   * effective behavior as pre-LOC-47 silent clobber but now flagged.
   */
  onConflict?: ConflictHandler;
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

/** Build the keep-both conflict-copy path: `notes/foo.md` → `notes/foo (conflict copy <iso-date>).md`. */
function makeConflictCopyPath(path: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dot = path.lastIndexOf('.');
  const slash = path.lastIndexOf('/');
  if (dot > slash && dot > 0) {
    return `${path.slice(0, dot)} (conflict copy ${stamp})${path.slice(dot)}`;
  }
  return `${path} (conflict copy ${stamp})`;
}

export class SyncEngine {
  private readonly client: VaultClient;
  private readonly manifest: ManifestManager;
  private readonly watcher: QueueSource;
  private readonly vault: SyncVault;
  private readonly masterKey: Uint8Array;
  private readonly onStatusChange?: (event: SyncStatusEvent) => void;
  private readonly onStateUpdate?: (knownSynced: Map<string, string>) => Promise<void> | void;
  private readonly onConflict?: ConflictHandler;
  private knownSynced: Map<string, string>;

  constructor(opts: SyncEngineOpts) {
    this.client = opts.client;
    this.manifest = opts.manifest;
    this.watcher = opts.watcher;
    this.vault = opts.vault;
    this.masterKey = opts.masterKey;
    this.onStatusChange = opts.onStatusChange;
    this.onStateUpdate = opts.onStateUpdate;
    this.onConflict = opts.onConflict;
    this.knownSynced = new Map(opts.knownSynced ?? []);
  }

  async sync(): Promise<void> {
    await this.pullChanges();
    await this.pushChanges();

    // Both halves of the round-trip succeeded — surface metrics for the trust-the-sync UI
    // (settings panel, status bar) and inform the server so the member dashboard can render
    // the same numbers. Server is zero-knowledge for vault contents; fileCount + lastSyncAt
    // are observability metadata, not material.
    const fileCount = this.manifest.getAllEntries().size;
    const lastSyncAt = new Date().toISOString();

    // Best-effort observability ping. The sync itself already succeeded — a transient
    // network blip or brief server hiccup must not turn a green sync into a red banner.
    // Surface to console so the failure is investigable, but do not rethrow.
    try {
      await this.client.patchStatus({ fileCount });
    } catch (err) {
      console.warn('[silent-stone] PATCH /api/vault/status failed (non-fatal):', err);
    }

    this.emit('idle', { lastSyncAt, fileCount });
  }

  async pullChanges(): Promise<void> {
    this.emit('syncing');
    try {
      await this.manifest.load();
      const entries = this.manifest.getAllEntries();

      const nextKnown = new Map<string, string>();

      for (const [path, entry] of entries) {
        const localExists = await this.vault.exists(path);

        if (!localExists) {
          // Server-only file → pull it down.
          const plaintext = await this.downloadAndDecrypt(entry);
          await this.vault.create(path, plaintext);
          nextKnown.set(path, entry.hash);
          continue;
        }

        const local = await this.vault.readBinary(path);
        const localHash = await sha256Hex(local);

        // Case 1: in sync.
        if (localHash === entry.hash) {
          nextKnown.set(path, entry.hash);
          continue;
        }

        // Differs. Consult the three-point comparison to decide why.
        const lastKnown = this.knownSynced.get(path);

        // Case 2: no reliable history (never synced, or migration sentinel).
        // Preserve local — record its actual hash so the next round has a real anchor.
        // pushChanges() will upload the local copy if the user wants it pushed.
        if (lastKnown === undefined || lastKnown === '') {
          nextKnown.set(path, localHash);
          continue;
        }

        // Case 3: local moved, server didn't → leave local alone, push will handle it.
        if (lastKnown === entry.hash) {
          nextKnown.set(path, localHash);
          continue;
        }

        // Case 4: server moved, local didn't → download.
        if (lastKnown === localHash) {
          const plaintext = await this.downloadAndDecrypt(entry);
          await this.vault.modify(path, plaintext);
          nextKnown.set(path, entry.hash);
          continue;
        }

        // Case 5: real divergence — both sides moved. Ask the handler.
        const serverPlaintext = await this.downloadAndDecrypt(entry);
        const resolution = await this.resolveConflict({
          path,
          localHash,
          serverHash: entry.hash,
          lastKnownHash: lastKnown,
          localContent: local,
          serverContent: serverPlaintext,
          serverModifiedAt: entry.modifiedAt,
        });

        if (resolution === 'keep-local') {
          nextKnown.set(path, localHash);
        } else if (resolution === 'keep-server') {
          await this.vault.modify(path, serverPlaintext);
          nextKnown.set(path, entry.hash);
        } else {
          // keep-both: server copy saved alongside local with a suffix; local stays put.
          const conflictPath = makeConflictCopyPath(path);
          await this.vault.create(conflictPath, serverPlaintext);
          nextKnown.set(path, localHash);
          nextKnown.set(conflictPath, entry.hash);
        }
      }

      // Deletions: a path that was known-synced and is missing from the server manifest
      // means the user (or another device) deleted it remotely. Mirror locally.
      for (const path of this.knownSynced.keys()) {
        if (!entries.has(path) && (await this.vault.exists(path))) {
          await this.vault.delete(path);
        }
      }

      this.knownSynced = nextKnown;
      if (this.onStateUpdate) await this.onStateUpdate(new Map(this.knownSynced));
      this.emit('idle');
    } catch (e) {
      this.emit('error', { errorMessage: e instanceof Error ? e.message : 'Unknown error' });
      throw e;
    }
  }

  private async resolveConflict(info: ConflictInfo): Promise<ConflictResolution> {
    if (this.onConflict) {
      return this.onConflict(info);
    }
    // No handler wired → fall back to server-wins, but flag it so the operator can
    // tell it apart from the pre-LOC-47 silent-clobber bug.
    console.warn(
      `[silent-stone] conflict on ${info.path}: no handler wired, defaulting to keep-server. ` +
        `local=${info.localHash.slice(0, 8)} server=${info.serverHash.slice(0, 8)} ` +
        `lastKnown=${info.lastKnownHash.slice(0, 8)}`,
    );
    return 'keep-server';
  }

  private async downloadAndDecrypt(entry: ManifestEntry): Promise<ArrayBuffer> {
    const blob = await this.client.getBlob(entry.blobId);
    const plaintext = await decryptBlob(new Uint8Array(blob), this.masterKey);
    return toArrayBuffer(plaintext);
  }

  async pushChanges(): Promise<void> {
    this.emit('syncing');
    try {
      // Source of truth for "what should exist server-side": every file
      // currently on disk in the vault. The watcher queue used to be the
      // only signal here, which silently lost pre-existing files because
      // the watcher only fires on events AFTER it starts listening.
      const paths = await this.vault.listAll();
      const localFiles = new Map<string, string>();
      const localContents = new Map<string, ArrayBuffer>();
      for (const path of paths) {
        const data = await this.vault.readBinary(path);
        localContents.set(path, data);
        localFiles.set(path, await sha256Hex(data));
      }

      const { toUpload, toDelete: diffDeletes } = this.manifest.diff(localFiles);

      // Watcher delete events still carry strong "user just deleted this"
      // intent. Combined with knownSynced, they gate the deletion path:
      // only delete blobs the user has either synced before OR explicitly
      // removed in Obsidian. Anything else is treated as an orphan and
      // preserved with a warning (see Issue #164 — tombstone tracking).
      const watcherDeletes = new Set<string>();
      for (const ev of this.watcher.getQueue()) {
        if (ev.kind === 'delete') watcherDeletes.add(ev.path);
      }

      const pendingSets: Array<[string, ManifestEntry]> = [];
      const pendingDeletes: string[] = [];

      for (const path of toUpload) {
        const plaintext = localContents.get(path)!;
        const hash = localFiles.get(path)!;
        const existing = this.manifest.getEntry(path);
        const blobId = existing?.blobId ?? crypto.randomUUID();
        const encrypted = await encryptBlob(new Uint8Array(plaintext), this.masterKey);
        await this.client.putBlob(blobId, toArrayBuffer(encrypted));

        const entry: ManifestEntry = {
          blobId,
          size: plaintext.byteLength,
          hash,
          modifiedAt: Date.now(),
        };
        this.manifest.setEntry(path, entry);
        pendingSets.push([path, entry]);
      }

      for (const path of diffDeletes) {
        if (!this.knownSynced.has(path) && !watcherDeletes.has(path)) {
          console.warn(
            '[silent-stone] orphaned manifest entry preserved (not in knownSynced):',
            path,
          );
          continue;
        }
        const existing = this.manifest.getEntry(path);
        if (!existing) continue;
        await this.client.deleteBlob(existing.blobId);
        this.manifest.deleteEntry(path);
        pendingDeletes.push(path);
      }

      const mutated = pendingSets.length > 0 || pendingDeletes.length > 0;
      if (mutated) {
        await this.saveWithRetry(pendingSets, pendingDeletes);
        // Rebuild knownSynced from the post-push manifest, preserving the per-path hash so
        // the next sync round has a real anchor for divergence detection.
        const next = new Map<string, string>();
        for (const [p, e] of this.manifest.getAllEntries()) next.set(p, e.hash);
        this.knownSynced = next;
        if (this.onStateUpdate) await this.onStateUpdate(new Map(this.knownSynced));
      }

      this.watcher.clearQueue();
      this.emit('idle');
    } catch (e) {
      this.emit('error', { errorMessage: e instanceof Error ? e.message : 'Unknown error' });
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

  private emit(
    state: SyncStatusEvent['state'],
    extras: Partial<Omit<SyncStatusEvent, 'state'>> = {},
  ): void {
    this.onStatusChange?.({ state, ...extras });
  }
}
