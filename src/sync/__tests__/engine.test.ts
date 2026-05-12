import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRequestUrl } = vi.hoisted(() => ({
  mockRequestUrl: vi.fn(),
}));

vi.mock('obsidian', () => ({
  requestUrl: mockRequestUrl,
}));

import { VaultClient } from '../../api/vault-client';
import { encryptBlob } from '../../crypto/cipher';
import { ManifestManager } from '../manifest';
import {
  SyncEngine,
  type ConflictInfo,
  type ConflictResolution,
  type SyncVault,
} from '../engine';
import type { ChangeEvent } from '../watcher';
import type { ManifestEntry } from '../manifest';
import type { SyncStatusEvent } from '../../types';
import type { VaultStatusResponse } from '../../api/vault-types';

// ── Helpers ────────────────────────────────────────
const BASE_URL = 'https://vault.example.com';
const TOKEN = 'test-bearer-token';
const MASTER_KEY = new Uint8Array(32).fill(0x42);

function okJson<T>(body: T, headers: Record<string, string> = {}) {
  return { status: 200, json: body, headers, arrayBuffer: new ArrayBuffer(0) };
}

function okBinary(bytes: ArrayBuffer, headers: Record<string, string> = {}) {
  return { status: 200, json: null, headers, arrayBuffer: bytes };
}

function httpError(status: number, body?: unknown) {
  return Object.assign(new Error(`HTTP ${status}`), { status, json: body });
}

async function encryptManifest(obj: unknown, key: Uint8Array): Promise<ArrayBuffer> {
  const bytes = await encryptBlob(new TextEncoder().encode(JSON.stringify(obj)), key);
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  return buf;
}

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** In-memory fake matching the SyncVault interface the engine needs. */
class FakeVault implements SyncVault {
  files: Map<string, ArrayBuffer> = new Map();

  async readBinary(path: string): Promise<ArrayBuffer> {
    const buf = this.files.get(path);
    if (!buf) throw new Error(`FakeVault: no file at ${path}`);
    return buf;
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  async create(path: string, data: ArrayBuffer): Promise<void> {
    this.files.set(path, data);
  }

  async modify(path: string, data: ArrayBuffer): Promise<void> {
    this.files.set(path, data);
  }

  async delete(path: string): Promise<void> {
    this.files.delete(path);
  }

  async listAll(): Promise<string[]> {
    return [...this.files.keys()];
  }
}

class FakeQueue {
  events: ChangeEvent[] = [];
  getQueue(): ChangeEvent[] {
    return [...this.events];
  }
  clearQueue(): void {
    this.events = [];
  }
}

interface Harness {
  engine: SyncEngine;
  manifest: ManifestManager;
  queue: FakeQueue;
  vault: FakeVault;
  client: VaultClient;
  statuses: string[];
  savedKnownSynced: Map<string, string>[];
  conflictCalls: ConflictInfo[];
}

interface HarnessOpts {
  knownSynced?: Map<string, string>;
  onConflict?: (info: ConflictInfo) => ConflictResolution | Promise<ConflictResolution>;
}

/** Assemble a fresh engine with empty manifest (404 on first getManifest). */
async function makeHarness(opts: HarnessOpts = {}): Promise<Harness> {
  mockRequestUrl.mockRejectedValueOnce(httpError(404));
  const client = new VaultClient(BASE_URL, TOKEN);
  const manifest = new ManifestManager(client, MASTER_KEY);
  await manifest.load();
  // Drop the harness's load() from call history so tests can index from call 0.
  mockRequestUrl.mockClear();

  const queue = new FakeQueue();
  const vault = new FakeVault();
  const statuses: string[] = [];
  const savedKnownSynced: Map<string, string>[] = [];
  const conflictCalls: ConflictInfo[] = [];
  const engine = new SyncEngine({
    client,
    manifest,
    watcher: queue,
    vault,
    masterKey: MASTER_KEY,
    onStatusChange: (e) => statuses.push(e.state),
    knownSynced: opts.knownSynced,
    onStateUpdate: async (ks) => {
      savedKnownSynced.push(new Map(ks));
    },
    onConflict: opts.onConflict
      ? (info) => {
          conflictCalls.push(info);
          return opts.onConflict!(info);
        }
      : undefined,
  });
  return { engine, manifest, queue, vault, client, statuses, savedKnownSynced, conflictCalls };
}

beforeEach(() => {
  mockRequestUrl.mockReset();
});

// ── pushChanges: no-op path ────────────────────────
describe('SyncEngine.pushChanges — empty queue', () => {
  it('makes no network calls when the queue is empty', async () => {
    const h = await makeHarness();

    await h.engine.pushChanges();

    expect(mockRequestUrl).not.toHaveBeenCalled();
    expect(h.statuses).toEqual(['syncing', 'idle']);
  });
});

// ── pushChanges: upload new file ───────────────────
describe('SyncEngine.pushChanges — new file', () => {
  it('reads, encrypts, PUTs blob, records manifest entry, and saves manifest', async () => {
    const h = await makeHarness();
    const plaintext = new TextEncoder().encode('hello world').buffer as ArrayBuffer;
    h.vault.files.set('greeting.md', plaintext);
    h.queue.events = [{ kind: 'upsert', path: 'greeting.md' }];

    // Mock: 1 putBlob, 1 putManifest
    mockRequestUrl.mockResolvedValueOnce(
      okJson({ ok: true, blobId: 'stub', size: plaintext.byteLength }),
    );
    mockRequestUrl.mockResolvedValueOnce(okJson({ ok: true, sequenceNumber: 1 }));

    await h.engine.pushChanges();

    // putBlob call
    const blobCall = mockRequestUrl.mock.calls[0][0];
    expect(blobCall.method).toBe('PUT');
    expect(blobCall.url).toMatch(/\/api\/vault\/blobs\/[0-9a-f-]{36}$/);

    // manifest entry created
    const entry = h.manifest.getEntry('greeting.md');
    expect(entry).toBeDefined();
    expect(entry?.hash).toBe(await sha256Hex(plaintext));
    expect(entry?.size).toBe(plaintext.byteLength);

    // putManifest called
    const manifestCall = mockRequestUrl.mock.calls[1][0];
    expect(manifestCall.url).toBe(`${BASE_URL}/api/vault/manifest`);
    expect(manifestCall.method).toBe('PUT');
    expect(h.manifest.sequenceNumber).toBe(1);

    expect(h.queue.getQueue()).toEqual([]);
  });
});

// ── pushChanges: modified file ─────────────────────
describe('SyncEngine.pushChanges — modified file', () => {
  it('reuses the existing blobId when hash differs', async () => {
    const h = await makeHarness();
    const oldContent = new TextEncoder().encode('v1').buffer as ArrayBuffer;
    const existingBlobId = '22222222-2222-4222-8222-222222222222';
    h.manifest.setEntry('doc.md', {
      blobId: existingBlobId,
      size: oldContent.byteLength,
      hash: await sha256Hex(oldContent),
      modifiedAt: 1,
    });

    const newContent = new TextEncoder().encode('v2 changed').buffer as ArrayBuffer;
    h.vault.files.set('doc.md', newContent);
    h.queue.events = [{ kind: 'upsert', path: 'doc.md' }];

    mockRequestUrl.mockResolvedValueOnce(
      okJson({ ok: true, blobId: existingBlobId, size: newContent.byteLength }),
    );
    mockRequestUrl.mockResolvedValueOnce(okJson({ ok: true, sequenceNumber: 1 }));

    await h.engine.pushChanges();

    const call = mockRequestUrl.mock.calls[0][0];
    expect(call.url).toBe(`${BASE_URL}/api/vault/blobs/${existingBlobId}`);

    const entry = h.manifest.getEntry('doc.md');
    expect(entry?.blobId).toBe(existingBlobId);
    expect(entry?.hash).toBe(await sha256Hex(newContent));
  });

  it('skips files whose local hash matches the manifest (spurious upsert)', async () => {
    const h = await makeHarness();
    const content = new TextEncoder().encode('unchanged').buffer as ArrayBuffer;
    h.manifest.setEntry('same.md', {
      blobId: '33333333-3333-4333-8333-333333333333',
      size: content.byteLength,
      hash: await sha256Hex(content),
      modifiedAt: 1,
    });
    h.vault.files.set('same.md', content);
    h.queue.events = [{ kind: 'upsert', path: 'same.md' }];

    // No mocked network calls — if engine calls out, mock returns undefined and we'd crash.
    await h.engine.pushChanges();

    expect(mockRequestUrl).not.toHaveBeenCalled();
    expect(h.statuses).toEqual(['syncing', 'idle']);
  });
});

// ── pushChanges: deletions ─────────────────────────
describe('SyncEngine.pushChanges — deletion', () => {
  it('DELETEs the blob, removes manifest entry, saves manifest', async () => {
    const h = await makeHarness();
    const blobId = '44444444-4444-4444-8444-444444444444';
    h.manifest.setEntry('gone.md', {
      blobId,
      size: 10,
      hash: 'abc',
      modifiedAt: 1,
    });
    h.queue.events = [{ kind: 'delete', path: 'gone.md' }];

    mockRequestUrl.mockResolvedValueOnce(okJson({ ok: true })); // deleteBlob
    mockRequestUrl.mockResolvedValueOnce(okJson({ ok: true, sequenceNumber: 1 })); // manifest

    await h.engine.pushChanges();

    const call = mockRequestUrl.mock.calls[0][0];
    expect(call.url).toBe(`${BASE_URL}/api/vault/blobs/${blobId}`);
    expect(call.method).toBe('DELETE');
    expect(h.manifest.getEntry('gone.md')).toBeUndefined();
  });

  it('is a no-op when deletion target is not in the manifest', async () => {
    const h = await makeHarness();
    h.queue.events = [{ kind: 'delete', path: 'never-existed.md' }];

    await h.engine.pushChanges();

    expect(mockRequestUrl).not.toHaveBeenCalled();
  });
});

// ── pushChanges: 409 conflict retry ────────────────
describe('SyncEngine.pushChanges — conflict retry', () => {
  it('reloads manifest and retries save once on 409', async () => {
    const h = await makeHarness();
    const plaintext = new TextEncoder().encode('contents').buffer as ArrayBuffer;
    h.vault.files.set('new.md', plaintext);
    h.queue.events = [{ kind: 'upsert', path: 'new.md' }];

    // putBlob success
    mockRequestUrl.mockResolvedValueOnce(okJson({ ok: true, blobId: 'x', size: 8 }));
    // putManifest → 409
    mockRequestUrl.mockRejectedValueOnce(
      httpError(409, { serverSequence: 5, clientSequence: 0 }),
    );
    // reload manifest (empty server state, decrypts fine)
    const remoteManifest = await encryptManifest(
      { version: 1, entries: {} },
      MASTER_KEY,
    );
    mockRequestUrl.mockResolvedValueOnce(
      okBinary(remoteManifest, { 'x-sequence-number': '5' }),
    );
    // putManifest retry → success
    mockRequestUrl.mockResolvedValueOnce(okJson({ ok: true, sequenceNumber: 6 }));

    await h.engine.pushChanges();

    expect(h.manifest.sequenceNumber).toBe(6);
    expect(h.manifest.getEntry('new.md')).toBeDefined();
    expect(h.statuses).toEqual(['syncing', 'idle']);
  });

  it('surfaces conflict as error status when retry also fails', async () => {
    const h = await makeHarness();
    const plaintext = new TextEncoder().encode('contents').buffer as ArrayBuffer;
    h.vault.files.set('new.md', plaintext);
    h.queue.events = [{ kind: 'upsert', path: 'new.md' }];

    mockRequestUrl.mockResolvedValueOnce(okJson({ ok: true, blobId: 'x', size: 8 }));
    mockRequestUrl.mockRejectedValueOnce(
      httpError(409, { serverSequence: 5, clientSequence: 0 }),
    );
    const remoteManifest = await encryptManifest(
      { version: 1, entries: {} },
      MASTER_KEY,
    );
    mockRequestUrl.mockResolvedValueOnce(
      okBinary(remoteManifest, { 'x-sequence-number': '5' }),
    );
    mockRequestUrl.mockRejectedValueOnce(
      httpError(409, { serverSequence: 9, clientSequence: 5 }),
    );

    await expect(h.engine.pushChanges()).rejects.toThrow();
    expect(h.statuses.at(-1)).toBe('error');
  });
});

// ── pushChanges: status transitions ────────────────
describe('SyncEngine.pushChanges — status callback', () => {
  it('transitions syncing → idle on success', async () => {
    const h = await makeHarness();
    const plaintext = new TextEncoder().encode('x').buffer as ArrayBuffer;
    h.vault.files.set('x.md', plaintext);
    h.queue.events = [{ kind: 'upsert', path: 'x.md' }];

    mockRequestUrl.mockResolvedValueOnce(okJson({ ok: true, blobId: 'x', size: 1 }));
    mockRequestUrl.mockResolvedValueOnce(okJson({ ok: true, sequenceNumber: 1 }));

    await h.engine.pushChanges();

    expect(h.statuses).toEqual(['syncing', 'idle']);
  });

  it('transitions syncing → error on blob upload failure', async () => {
    const h = await makeHarness();
    const plaintext = new TextEncoder().encode('x').buffer as ArrayBuffer;
    h.vault.files.set('fail.md', plaintext);
    h.queue.events = [{ kind: 'upsert', path: 'fail.md' }];

    mockRequestUrl.mockRejectedValueOnce(httpError(500, { error: 'boom' }));

    await expect(h.engine.pushChanges()).rejects.toThrow();
    expect(h.statuses).toEqual(['syncing', 'error']);
  });
});

// ── pullChanges ────────────────────────────────────
describe('SyncEngine.pullChanges — new files from server', () => {
  it('downloads and decrypts a blob into vault.create when local is missing', async () => {
    const h = await makeHarness();
    const blobId = '55555555-5555-4555-8555-555555555555';
    const plaintext = new TextEncoder().encode('server file').buffer as ArrayBuffer;

    // Build encrypted blob and encrypted manifest containing one entry.
    const encryptedBlob = await encryptBlob(new Uint8Array(plaintext), MASTER_KEY);
    const blobBuf = new ArrayBuffer(encryptedBlob.byteLength);
    new Uint8Array(blobBuf).set(encryptedBlob);

    const entry: ManifestEntry = {
      blobId,
      size: plaintext.byteLength,
      hash: await sha256Hex(plaintext),
      modifiedAt: 1,
    };
    const encManifest = await encryptManifest(
      { version: 1, entries: { 'server.md': entry } },
      MASTER_KEY,
    );

    mockRequestUrl.mockResolvedValueOnce(
      okBinary(encManifest, { 'x-sequence-number': '3' }),
    );
    mockRequestUrl.mockResolvedValueOnce(okBinary(blobBuf));

    await h.engine.pullChanges();

    const local = await h.vault.readBinary('server.md');
    expect(new TextDecoder().decode(local)).toBe('server file');
  });

  it('uses vault.modify when the local file already exists and hash differs (one-sided server change)', async () => {
    // Setup: local hash === lastKnown === oldPlaintext hash. Server moved to newPlaintext.
    // This is case 4 in the divergence matrix — server moved, local didn't → download.
    const newPlaintext = new TextEncoder().encode('new version').buffer as ArrayBuffer;
    const oldPlaintext = new TextEncoder().encode('old version').buffer as ArrayBuffer;
    const oldHash = await sha256Hex(oldPlaintext);

    const h = await makeHarness({ knownSynced: new Map([['doc.md', oldHash]]) });
    const blobId = '66666666-6666-4666-8666-666666666666';
    h.vault.files.set('doc.md', oldPlaintext);

    const encryptedBlob = await encryptBlob(new Uint8Array(newPlaintext), MASTER_KEY);
    const blobBuf = new ArrayBuffer(encryptedBlob.byteLength);
    new Uint8Array(blobBuf).set(encryptedBlob);

    const entry: ManifestEntry = {
      blobId,
      size: newPlaintext.byteLength,
      hash: await sha256Hex(newPlaintext),
      modifiedAt: 2,
    };
    const encManifest = await encryptManifest(
      { version: 1, entries: { 'doc.md': entry } },
      MASTER_KEY,
    );

    mockRequestUrl.mockResolvedValueOnce(
      okBinary(encManifest, { 'x-sequence-number': '4' }),
    );
    mockRequestUrl.mockResolvedValueOnce(okBinary(blobBuf));

    await h.engine.pullChanges();

    const local = await h.vault.readBinary('doc.md');
    expect(new TextDecoder().decode(local)).toBe('new version');
  });

  it('skips download when local hash already matches manifest entry', async () => {
    const h = await makeHarness();
    const plaintext = new TextEncoder().encode('identical').buffer as ArrayBuffer;
    h.vault.files.set('same.md', plaintext);

    const entry: ManifestEntry = {
      blobId: 'unused',
      size: plaintext.byteLength,
      hash: await sha256Hex(plaintext),
      modifiedAt: 1,
    };
    const encManifest = await encryptManifest(
      { version: 1, entries: { 'same.md': entry } },
      MASTER_KEY,
    );

    mockRequestUrl.mockResolvedValueOnce(
      okBinary(encManifest, { 'x-sequence-number': '1' }),
    );

    await h.engine.pullChanges();

    // Only the manifest load — no blob GET
    expect(mockRequestUrl).toHaveBeenCalledTimes(1);
  });
});

describe('SyncEngine.pullChanges — deletions with known-synced guard', () => {
  it('deletes local file that was previously synced but no longer in manifest', async () => {
    const oldPlaintext = new TextEncoder().encode('to delete').buffer as ArrayBuffer;
    const h = await makeHarness({
      knownSynced: new Map([['old.md', await sha256Hex(oldPlaintext)]]),
    });
    h.vault.files.set('old.md', oldPlaintext);

    const encManifest = await encryptManifest(
      { version: 1, entries: {} },
      MASTER_KEY,
    );
    mockRequestUrl.mockResolvedValueOnce(
      okBinary(encManifest, { 'x-sequence-number': '2' }),
    );

    await h.engine.pullChanges();

    expect(await h.vault.exists('old.md')).toBe(false);
  });

  it('PRESERVES local file that was never synced (not in known-synced)', async () => {
    const h = await makeHarness(); // empty known-synced
    const plaintext = new TextEncoder().encode('local only').buffer as ArrayBuffer;
    h.vault.files.set('unsynced-local.md', plaintext);

    const encManifest = await encryptManifest(
      { version: 1, entries: {} },
      MASTER_KEY,
    );
    mockRequestUrl.mockResolvedValueOnce(
      okBinary(encManifest, { 'x-sequence-number': '1' }),
    );

    await h.engine.pullChanges();

    expect(await h.vault.exists('unsynced-local.md')).toBe(true);
  });

  it('persists updated known-synced set via onStateUpdate after a successful pull', async () => {
    const h = await makeHarness();
    const plaintext = new TextEncoder().encode('x').buffer as ArrayBuffer;
    const encryptedBlob = await encryptBlob(new Uint8Array(plaintext), MASTER_KEY);
    const blobBuf = new ArrayBuffer(encryptedBlob.byteLength);
    new Uint8Array(blobBuf).set(encryptedBlob);

    const entry: ManifestEntry = {
      blobId: '77777777-7777-4777-8777-777777777777',
      size: 1,
      hash: await sha256Hex(plaintext),
      modifiedAt: 1,
    };
    const encManifest = await encryptManifest(
      { version: 1, entries: { 'a.md': entry, 'b.md': entry } },
      MASTER_KEY,
    );

    mockRequestUrl.mockResolvedValueOnce(
      okBinary(encManifest, { 'x-sequence-number': '1' }),
    );
    mockRequestUrl.mockResolvedValueOnce(okBinary(blobBuf));
    mockRequestUrl.mockResolvedValueOnce(okBinary(blobBuf));

    await h.engine.pullChanges();

    expect(h.savedKnownSynced.length).toBeGreaterThan(0);
    const latest = h.savedKnownSynced[h.savedKnownSynced.length - 1];
    expect([...latest.keys()].sort()).toEqual(['a.md', 'b.md']);
    // And the values are the file's plaintext hash, not just paths.
    expect(latest.get('a.md')).toBe(await sha256Hex(plaintext));
    expect(latest.get('b.md')).toBe(await sha256Hex(plaintext));
  });
});

describe('SyncEngine.sync — orchestrator', () => {
  it('runs pullChanges before pushChanges', async () => {
    const h = await makeHarness();
    // Empty server manifest
    const encManifest = await encryptManifest(
      { version: 1, entries: {} },
      MASTER_KEY,
    );
    mockRequestUrl.mockResolvedValueOnce(
      okBinary(encManifest, { 'x-sequence-number': '0' }),
    );

    // Local upload pending
    const plaintext = new TextEncoder().encode('push me').buffer as ArrayBuffer;
    h.vault.files.set('up.md', plaintext);
    h.queue.events = [{ kind: 'upsert', path: 'up.md' }];

    mockRequestUrl.mockResolvedValueOnce(okJson({ ok: true, blobId: 'x', size: 7 }));
    mockRequestUrl.mockResolvedValueOnce(okJson({ ok: true, sequenceNumber: 1 }));
    // sync() also POSTs fileCount → mock the patchStatus reply so the assertion
    // surface stays focused on the existing pull+push behaviour.
    mockRequestUrl.mockResolvedValueOnce(
      okJson<VaultStatusResponse>({
        storageUsedBytes: 7,
        storageLimitBytes: 1000,
        tier: 'free',
        lastSyncAt: '2026-04-26T20:00:00Z',
        manifestSeq: 1,
        fileCount: 1,
        keysConfigured: false,
        suspended: false,
      }),
    );

    await h.engine.sync();

    expect(mockRequestUrl.mock.calls[0][0].url).toBe(`${BASE_URL}/api/vault/manifest`);
    expect(mockRequestUrl.mock.calls[0][0].method).toBe('GET');
    // Second call is the blob PUT
    expect(mockRequestUrl.mock.calls[1][0].method).toBe('PUT');
    expect(mockRequestUrl.mock.calls[1][0].url).toMatch(/\/blobs\//);
  });
});

// ── sync(): trust-the-sync metrics + patchStatus POST ──
describe('SyncEngine.sync — final metrics event + observability ping', () => {
  it('POSTs fileCount via PATCH /api/vault/status and emits a final enriched idle event', async () => {
    // Initial 404 for manifest setup
    mockRequestUrl.mockRejectedValueOnce(httpError(404));
    const client = new VaultClient(BASE_URL, TOKEN);
    const manifest = new ManifestManager(client, MASTER_KEY);
    await manifest.load();
    mockRequestUrl.mockClear();

    const events: SyncStatusEvent[] = [];
    const queue = new FakeQueue(); // empty — push is a no-op
    const vault = new FakeVault();

    const engine = new SyncEngine({
      client,
      manifest,
      watcher: queue,
      vault,
      masterKey: MASTER_KEY,
      onStatusChange: (e) => events.push(e),
    });

    // pull's manifest.load() → 404 (no remote entries) → emits syncing+idle
    mockRequestUrl.mockRejectedValueOnce(httpError(404));
    // patchStatus → updated VaultStatusResponse
    mockRequestUrl.mockResolvedValueOnce(
      okJson<VaultStatusResponse>({
        storageUsedBytes: 0,
        storageLimitBytes: 1000,
        tier: 'free',
        lastSyncAt: '2026-04-26T20:00:00Z',
        manifestSeq: 0,
        fileCount: 0,
        keysConfigured: false,
        suspended: false,
      }),
    );

    await engine.sync();

    // Final event must be the canonical sync-complete: idle + metrics
    const last = events.at(-1)!;
    expect(last.state).toBe('idle');
    expect(last.fileCount).toBe(0);
    expect(typeof last.lastSyncAt).toBe('string');

    // PATCH /api/vault/status was called with the right shape
    const calls = mockRequestUrl.mock.calls;
    const patchCall = calls.find((c) => (c[0] as { method: string }).method === 'PATCH');
    expect(patchCall).toBeDefined();
    const patchArgs = patchCall![0] as { url: string; method: string; body: string };
    expect(patchArgs.url).toBe(`${BASE_URL}/api/vault/status`);
    expect(JSON.parse(patchArgs.body)).toEqual({ fileCount: 0 });
  });

  it('does not turn a successful sync into an error if patchStatus fails (best-effort)', async () => {
    // Silence the expected console.warn for the failed patchStatus.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    mockRequestUrl.mockRejectedValueOnce(httpError(404));
    const client = new VaultClient(BASE_URL, TOKEN);
    const manifest = new ManifestManager(client, MASTER_KEY);
    await manifest.load();
    mockRequestUrl.mockClear();

    const events: SyncStatusEvent[] = [];
    const queue = new FakeQueue();
    const vault = new FakeVault();

    const engine = new SyncEngine({
      client,
      manifest,
      watcher: queue,
      vault,
      masterKey: MASTER_KEY,
      onStatusChange: (e) => events.push(e),
    });

    mockRequestUrl.mockRejectedValueOnce(httpError(404)); // pull
    mockRequestUrl.mockRejectedValueOnce(httpError(500)); // patchStatus blows up

    await expect(engine.sync()).resolves.toBeUndefined();

    // Final event still idle — sync itself succeeded even though patchStatus failed
    expect(events.at(-1)?.state).toBe('idle');
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('emits state: error with errorMessage when push fails', async () => {
    mockRequestUrl.mockRejectedValueOnce(httpError(404));
    const client = new VaultClient(BASE_URL, TOKEN);
    const manifest = new ManifestManager(client, MASTER_KEY);
    await manifest.load();
    mockRequestUrl.mockClear();

    const events: SyncStatusEvent[] = [];
    const queue = new FakeQueue();
    const vault = new FakeVault();
    const plaintext = new TextEncoder().encode('boom').buffer as ArrayBuffer;
    vault.files.set('boom.md', plaintext);
    queue.events = [{ kind: 'upsert', path: 'boom.md' }];

    const engine = new SyncEngine({
      client,
      manifest,
      watcher: queue,
      vault,
      masterKey: MASTER_KEY,
      onStatusChange: (e) => events.push(e),
    });

    mockRequestUrl.mockRejectedValueOnce(httpError(404)); // pull is empty (no manifest)
    mockRequestUrl.mockRejectedValueOnce(httpError(500, { error: 'kaboom' })); // blob upload fails

    await expect(engine.sync()).rejects.toThrow();

    const errorEvent = events.find((e) => e.state === 'error');
    expect(errorEvent).toBeDefined();
    expect(errorEvent!.errorMessage).toBeDefined();
    expect(typeof errorEvent!.errorMessage).toBe('string');
  });
});

// ── pushChanges — trust-the-sync regression ────────
// Three regression tests for the v0.1.7 bug: pushChanges() relied entirely on
// watcher.getQueue(), so pre-existing vault files (created before watcher.start
// ever ran) were never enumerated and never uploaded. The UI still reported
// "Synced — Files: 0" and the server saw 0 B. After the fix, pushChanges
// enumerates vault.listAll(), diffs against the manifest, and uploads the gap.
describe('SyncEngine.pushChanges — pre-existing vault files (no watcher events)', () => {
  it('uploads files that exist locally but are missing from the manifest, even with empty queue', async () => {
    const h = await makeHarness();
    const a = new TextEncoder().encode('alpha').buffer as ArrayBuffer;
    const b = new TextEncoder().encode('beta').buffer as ArrayBuffer;
    const c = new TextEncoder().encode('gamma').buffer as ArrayBuffer;
    h.vault.files.set('a.md', a);
    h.vault.files.set('b.md', b);
    h.vault.files.set('c.md', c);
    h.queue.events = []; // The smoking gun.

    // 3 putBlob + 1 putManifest
    mockRequestUrl.mockResolvedValueOnce(okJson({ ok: true, blobId: 'x', size: 5 }));
    mockRequestUrl.mockResolvedValueOnce(okJson({ ok: true, blobId: 'x', size: 4 }));
    mockRequestUrl.mockResolvedValueOnce(okJson({ ok: true, blobId: 'x', size: 5 }));
    mockRequestUrl.mockResolvedValueOnce(okJson({ ok: true, sequenceNumber: 1 }));

    await h.engine.pushChanges();

    const blobCalls = mockRequestUrl.mock.calls.filter((call) => {
      const args = call[0] as { method: string; url: string };
      return args.method === 'PUT' && /\/api\/vault\/blobs\/[0-9a-f-]{36}$/.test(args.url);
    });
    expect(blobCalls).toHaveLength(3);

    const manifestCall = mockRequestUrl.mock.calls.find((call) => {
      const args = call[0] as { method: string; url: string };
      return args.method === 'PUT' && args.url.endsWith('/api/vault/manifest');
    });
    expect(manifestCall).toBeDefined();

    expect(h.manifest.getEntry('a.md')).toBeDefined();
    expect(h.manifest.getEntry('b.md')).toBeDefined();
    expect(h.manifest.getEntry('c.md')).toBeDefined();
  });
});

describe('SyncEngine.pushChanges — deletion via diff with knownSynced guard', () => {
  it('deletes blobs for files in manifest + knownSynced that are missing locally, with no watcher event', async () => {
    const a = new TextEncoder().encode('alpha').buffer as ArrayBuffer;
    const aHash = await sha256Hex(a);
    // knownSynced maps each previously-synced path to its last-known plaintext hash.
    // For b.md we don't have the bytes anymore — use the same placeholder hash that the
    // manifest entry below uses, so it's consistent with the per-path-hash contract.
    const h = await makeHarness({
      knownSynced: new Map([
        ['a.md', aHash],
        ['b.md', 'beta-hash'],
      ]),
    });
    h.vault.files.set('a.md', a);

    h.manifest.setEntry('a.md', {
      blobId: '11111111-1111-4111-8111-111111111111',
      size: a.byteLength,
      hash: aHash,
      modifiedAt: 1,
    });
    const bBlobId = '22222222-2222-4222-8222-222222222222';
    h.manifest.setEntry('b.md', {
      blobId: bBlobId,
      size: 4,
      hash: 'beta-hash',
      modifiedAt: 1,
    });
    h.queue.events = []; // diff-driven, no watcher event

    mockRequestUrl.mockResolvedValueOnce(okJson({ ok: true })); // deleteBlob b
    mockRequestUrl.mockResolvedValueOnce(okJson({ ok: true, sequenceNumber: 1 })); // manifest

    await h.engine.pushChanges();

    const deleteCall = mockRequestUrl.mock.calls.find((call) => {
      const args = call[0] as { method: string; url: string };
      return args.method === 'DELETE' && args.url.endsWith(bBlobId);
    });
    expect(deleteCall).toBeDefined();
    expect(h.manifest.getEntry('b.md')).toBeUndefined();
    expect(h.manifest.getEntry('a.md')).toBeDefined();
  });
});

describe('SyncEngine.pushChanges — orphan guard', () => {
  it('does NOT delete a manifest entry that was never in knownSynced and has no watcher delete event', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const h = await makeHarness(); // empty knownSynced

    h.manifest.setEntry('orphan.md', {
      blobId: '33333333-3333-4333-8333-333333333333',
      size: 10,
      hash: 'orphan-hash',
      modifiedAt: 1,
    });
    h.queue.events = []; // no watcher hint

    await h.engine.pushChanges();

    expect(mockRequestUrl).not.toHaveBeenCalled();
    expect(h.manifest.getEntry('orphan.md')).toBeDefined();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

// ── pullChanges — divergence-based conflict detection (LOC-47) ────
// Three reference points decide which case fires:
//   localHash  — sha256 of the file on disk right now
//   serverHash — manifestEntry.hash (server side after decryption)
//   lastKnown  — knownSynced.get(path) — what was on disk last successful sync
//
// Conflict (case 5) iff localHash !== serverHash AND lastKnown !== localHash AND
// lastKnown !== serverHash. Anything else is a one-sided change or "in sync."
describe('SyncEngine.pullChanges — divergence-based conflict detection', () => {
  /** Build an encrypted blob + manifest containing `path → entry`. */
  async function buildServerState(
    path: string,
    plaintext: ArrayBuffer,
    blobId: string,
  ): Promise<{ entry: ManifestEntry; blobBuf: ArrayBuffer; encManifest: ArrayBuffer }> {
    const encryptedBlob = await encryptBlob(new Uint8Array(plaintext), MASTER_KEY);
    const blobBuf = new ArrayBuffer(encryptedBlob.byteLength);
    new Uint8Array(blobBuf).set(encryptedBlob);
    const entry: ManifestEntry = {
      blobId,
      size: plaintext.byteLength,
      hash: await sha256Hex(plaintext),
      modifiedAt: 99,
    };
    const encManifest = await encryptManifest(
      { version: 1, entries: { [path]: entry } },
      MASTER_KEY,
    );
    return { entry, blobBuf, encManifest };
  }

  it('case 3 — one-sided local change: lastKnown matches server, local moved → preserves local, no download', async () => {
    const serverPlaintext = new TextEncoder().encode('shared').buffer as ArrayBuffer;
    const localPlaintext = new TextEncoder().encode('local edits').buffer as ArrayBuffer;
    const serverHash = await sha256Hex(serverPlaintext);
    const localHash = await sha256Hex(localPlaintext);

    // lastKnown === serverHash → user edited locally since last sync. Server unchanged.
    const h = await makeHarness({ knownSynced: new Map([['notes.md', serverHash]]) });
    h.vault.files.set('notes.md', localPlaintext);

    const { encManifest } = await buildServerState(
      'notes.md',
      serverPlaintext,
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    );
    mockRequestUrl.mockResolvedValueOnce(
      okBinary(encManifest, { 'x-sequence-number': '1' }),
    );

    await h.engine.pullChanges();

    // Local untouched — bytes still match local edit.
    const stillLocal = await h.vault.readBinary('notes.md');
    expect(new TextDecoder().decode(stillLocal)).toBe('local edits');
    // Only the manifest GET — no blob download.
    expect(mockRequestUrl).toHaveBeenCalledTimes(1);
    // No conflict handler call.
    expect(h.conflictCalls).toHaveLength(0);
    // Persisted knownSynced now reflects the actual local hash.
    const latest = h.savedKnownSynced.at(-1)!;
    expect(latest.get('notes.md')).toBe(localHash);
  });

  it('case 4 — one-sided server change: lastKnown matches local, server moved → downloads', async () => {
    const oldPlaintext = new TextEncoder().encode('original').buffer as ArrayBuffer;
    const newServerPlaintext = new TextEncoder().encode('server-updated').buffer as ArrayBuffer;
    const oldHash = await sha256Hex(oldPlaintext);

    // lastKnown === localHash (oldHash) → local unchanged. Server moved to new content.
    const h = await makeHarness({ knownSynced: new Map([['notes.md', oldHash]]) });
    h.vault.files.set('notes.md', oldPlaintext);

    const { blobBuf, encManifest } = await buildServerState(
      'notes.md',
      newServerPlaintext,
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    );
    mockRequestUrl.mockResolvedValueOnce(
      okBinary(encManifest, { 'x-sequence-number': '2' }),
    );
    mockRequestUrl.mockResolvedValueOnce(okBinary(blobBuf));

    await h.engine.pullChanges();

    const after = await h.vault.readBinary('notes.md');
    expect(new TextDecoder().decode(after)).toBe('server-updated');
    expect(h.conflictCalls).toHaveLength(0);
  });

  it('case 5 — both sides changed: conflict handler fires with all three hashes', async () => {
    const baselinePlaintext = new TextEncoder().encode('baseline v1').buffer as ArrayBuffer;
    const localPlaintext = new TextEncoder().encode('local changes').buffer as ArrayBuffer;
    const serverPlaintext = new TextEncoder().encode('server changes').buffer as ArrayBuffer;
    const baselineHash = await sha256Hex(baselinePlaintext);
    const localHash = await sha256Hex(localPlaintext);
    const serverHash = await sha256Hex(serverPlaintext);

    const onConflict = vi.fn<(info: ConflictInfo) => ConflictResolution>(() => 'keep-local');
    const h = await makeHarness({
      knownSynced: new Map([['notes.md', baselineHash]]),
      onConflict,
    });
    h.vault.files.set('notes.md', localPlaintext);

    const { blobBuf, encManifest } = await buildServerState(
      'notes.md',
      serverPlaintext,
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    );
    mockRequestUrl.mockResolvedValueOnce(
      okBinary(encManifest, { 'x-sequence-number': '3' }),
    );
    mockRequestUrl.mockResolvedValueOnce(okBinary(blobBuf));

    await h.engine.pullChanges();

    expect(onConflict).toHaveBeenCalledOnce();
    const info = h.conflictCalls[0];
    expect(info.path).toBe('notes.md');
    expect(info.localHash).toBe(localHash);
    expect(info.serverHash).toBe(serverHash);
    expect(info.lastKnownHash).toBe(baselineHash);
    // localContent and serverContent should round-trip the plaintexts.
    expect(new TextDecoder().decode(info.localContent)).toBe('local changes');
    expect(new TextDecoder().decode(info.serverContent)).toBe('server changes');
  });

  it('case 5 resolution: keep-local → preserves local bytes, knownSynced tracks localHash', async () => {
    const baseline = new TextEncoder().encode('baseline').buffer as ArrayBuffer;
    const local = new TextEncoder().encode('local').buffer as ArrayBuffer;
    const server = new TextEncoder().encode('server').buffer as ArrayBuffer;
    const localHash = await sha256Hex(local);

    const h = await makeHarness({
      knownSynced: new Map([['n.md', await sha256Hex(baseline)]]),
      onConflict: () => 'keep-local',
    });
    h.vault.files.set('n.md', local);

    const { blobBuf, encManifest } = await buildServerState(
      'n.md',
      server,
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    );
    mockRequestUrl.mockResolvedValueOnce(
      okBinary(encManifest, { 'x-sequence-number': '4' }),
    );
    mockRequestUrl.mockResolvedValueOnce(okBinary(blobBuf));

    await h.engine.pullChanges();

    expect(new TextDecoder().decode(await h.vault.readBinary('n.md'))).toBe('local');
    expect(h.savedKnownSynced.at(-1)!.get('n.md')).toBe(localHash);
  });

  it('case 5 resolution: keep-server → vault.modify with server bytes, knownSynced tracks serverHash', async () => {
    const baseline = new TextEncoder().encode('baseline').buffer as ArrayBuffer;
    const local = new TextEncoder().encode('local').buffer as ArrayBuffer;
    const server = new TextEncoder().encode('server').buffer as ArrayBuffer;
    const serverHash = await sha256Hex(server);

    const h = await makeHarness({
      knownSynced: new Map([['n.md', await sha256Hex(baseline)]]),
      onConflict: () => 'keep-server',
    });
    h.vault.files.set('n.md', local);

    const { blobBuf, encManifest } = await buildServerState(
      'n.md',
      server,
      'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    );
    mockRequestUrl.mockResolvedValueOnce(
      okBinary(encManifest, { 'x-sequence-number': '5' }),
    );
    mockRequestUrl.mockResolvedValueOnce(okBinary(blobBuf));

    await h.engine.pullChanges();

    expect(new TextDecoder().decode(await h.vault.readBinary('n.md'))).toBe('server');
    expect(h.savedKnownSynced.at(-1)!.get('n.md')).toBe(serverHash);
  });

  it('case 5 resolution: keep-both → server saved at suffixed path, local untouched', async () => {
    const baseline = new TextEncoder().encode('baseline').buffer as ArrayBuffer;
    const local = new TextEncoder().encode('local').buffer as ArrayBuffer;
    const server = new TextEncoder().encode('server').buffer as ArrayBuffer;

    const h = await makeHarness({
      knownSynced: new Map([['n.md', await sha256Hex(baseline)]]),
      onConflict: () => 'keep-both',
    });
    h.vault.files.set('n.md', local);

    const { blobBuf, encManifest } = await buildServerState(
      'n.md',
      server,
      'ffffffff-ffff-4fff-8fff-ffffffffffff',
    );
    mockRequestUrl.mockResolvedValueOnce(
      okBinary(encManifest, { 'x-sequence-number': '6' }),
    );
    mockRequestUrl.mockResolvedValueOnce(okBinary(blobBuf));

    await h.engine.pullChanges();

    // Local untouched.
    expect(new TextDecoder().decode(await h.vault.readBinary('n.md'))).toBe('local');
    // Some other path was created that contains the server bytes and has the
    // conflict-copy marker in its name.
    const created = [...h.vault.files.keys()].filter((p) => p !== 'n.md');
    expect(created.length).toBe(1);
    expect(created[0]).toMatch(/conflict copy/);
    expect(new TextDecoder().decode(await h.vault.readBinary(created[0]))).toBe('server');
  });

  it('migration sentinel (empty-string value) → preserves local, records actual local hash, no conflict prompt', async () => {
    // Simulates the legacy persisted shape after main.ts hydrates it: every previously
    // known path is in the map but the value is `''` (no real history). The first round
    // after the upgrade must NOT false-positive into a conflict.
    const localPlaintext = new TextEncoder().encode('local-only edits').buffer as ArrayBuffer;
    const serverPlaintext = new TextEncoder().encode('different content').buffer as ArrayBuffer;
    const localHash = await sha256Hex(localPlaintext);

    const onConflict = vi.fn<(info: ConflictInfo) => ConflictResolution>(() => 'keep-server');
    const h = await makeHarness({
      knownSynced: new Map([['legacy.md', '']]), // migration sentinel
      onConflict,
    });
    h.vault.files.set('legacy.md', localPlaintext);

    const { encManifest } = await buildServerState(
      'legacy.md',
      serverPlaintext,
      'aaaaaaaa-aaaa-4aaa-8aaa-bbbbbbbbbbbb',
    );
    mockRequestUrl.mockResolvedValueOnce(
      okBinary(encManifest, { 'x-sequence-number': '7' }),
    );

    await h.engine.pullChanges();

    // Local preserved despite differing from server (sentinel ≠ confirmed conflict).
    expect(new TextDecoder().decode(await h.vault.readBinary('legacy.md'))).toBe(
      'local-only edits',
    );
    expect(onConflict).not.toHaveBeenCalled();
    // Hash now real — next round will have a proper anchor.
    expect(h.savedKnownSynced.at(-1)!.get('legacy.md')).toBe(localHash);
    // Only the manifest GET was made — no blob fetch.
    expect(mockRequestUrl).toHaveBeenCalledTimes(1);
  });

  it('no handler wired + real conflict → defaults to keep-server with a console.warn', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const baseline = new TextEncoder().encode('baseline').buffer as ArrayBuffer;
    const local = new TextEncoder().encode('local').buffer as ArrayBuffer;
    const server = new TextEncoder().encode('server').buffer as ArrayBuffer;

    const h = await makeHarness({
      knownSynced: new Map([['n.md', await sha256Hex(baseline)]]),
      // onConflict deliberately omitted
    });
    h.vault.files.set('n.md', local);

    const { blobBuf, encManifest } = await buildServerState(
      'n.md',
      server,
      'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    );
    mockRequestUrl.mockResolvedValueOnce(
      okBinary(encManifest, { 'x-sequence-number': '8' }),
    );
    mockRequestUrl.mockResolvedValueOnce(okBinary(blobBuf));

    await h.engine.pullChanges();

    expect(new TextDecoder().decode(await h.vault.readBinary('n.md'))).toBe('server');
    expect(warnSpy).toHaveBeenCalled();
    const warnArg = warnSpy.mock.calls[0]?.[0] as string;
    expect(warnArg).toMatch(/conflict on n\.md/);
    warnSpy.mockRestore();
  });
});

// ── pushChanges — knownSynced records per-file hash (LOC-47) ────
describe('SyncEngine.pushChanges — knownSynced carries per-file hash', () => {
  it('after upload, persisted knownSynced maps each pushed path to its plaintext sha256', async () => {
    const h = await makeHarness();
    const plaintextA = new TextEncoder().encode('alpha').buffer as ArrayBuffer;
    const plaintextB = new TextEncoder().encode('beta').buffer as ArrayBuffer;
    h.vault.files.set('a.md', plaintextA);
    h.vault.files.set('b.md', plaintextB);
    h.queue.events = [{ kind: 'upsert', path: 'a.md' }];

    mockRequestUrl.mockResolvedValueOnce(okJson({ ok: true, blobId: 'x', size: 5 }));
    mockRequestUrl.mockResolvedValueOnce(okJson({ ok: true, blobId: 'x', size: 4 }));
    mockRequestUrl.mockResolvedValueOnce(okJson({ ok: true, sequenceNumber: 1 }));

    await h.engine.pushChanges();

    const latest = h.savedKnownSynced.at(-1)!;
    expect(latest.get('a.md')).toBe(await sha256Hex(plaintextA));
    expect(latest.get('b.md')).toBe(await sha256Hex(plaintextB));
  });
});
