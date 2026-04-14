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
import { SyncEngine, type SyncVault } from '../engine';
import type { ChangeEvent } from '../watcher';
import type { ManifestEntry } from '../manifest';

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
  savedKnownSynced: Set<string>[];
}

interface HarnessOpts {
  knownSynced?: Set<string>;
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
  const savedKnownSynced: Set<string>[] = [];
  const engine = new SyncEngine({
    client,
    manifest,
    watcher: queue,
    vault,
    masterKey: MASTER_KEY,
    onStatusChange: (s) => statuses.push(s),
    knownSynced: opts.knownSynced,
    onStateUpdate: async (ks) => {
      savedKnownSynced.push(new Set(ks));
    },
  });
  return { engine, manifest, queue, vault, client, statuses, savedKnownSynced };
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

  it('uses vault.modify when the local file already exists and hash differs', async () => {
    const h = await makeHarness();
    const blobId = '66666666-6666-4666-8666-666666666666';
    const newPlaintext = new TextEncoder().encode('new version').buffer as ArrayBuffer;
    const oldPlaintext = new TextEncoder().encode('old version').buffer as ArrayBuffer;
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
    const h = await makeHarness({ knownSynced: new Set(['old.md']) });
    const plaintext = new TextEncoder().encode('to delete').buffer as ArrayBuffer;
    h.vault.files.set('old.md', plaintext);

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
    expect([...latest].sort()).toEqual(['a.md', 'b.md']);
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

    await h.engine.sync();

    expect(mockRequestUrl.mock.calls[0][0].url).toBe(`${BASE_URL}/api/vault/manifest`);
    expect(mockRequestUrl.mock.calls[0][0].method).toBe('GET');
    // Second call is the blob PUT
    expect(mockRequestUrl.mock.calls[1][0].method).toBe('PUT');
    expect(mockRequestUrl.mock.calls[1][0].url).toMatch(/\/blobs\//);
  });
});
