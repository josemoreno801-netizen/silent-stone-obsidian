import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock `obsidian` ────────────────────────────────
// ManifestManager depends indirectly on VaultClient, which imports `requestUrl`
// from 'obsidian'. Mock it the same way the VaultClient suite does so tests
// run in node without pulling in Obsidian's runtime.
const { mockRequestUrl } = vi.hoisted(() => ({
  mockRequestUrl: vi.fn(),
}));

vi.mock('obsidian', () => ({
  requestUrl: mockRequestUrl,
}));

import { VaultClient } from '../../api/vault-client';
import { encryptBlob } from '../../crypto/cipher';
import {
  ManifestConflictError,
  ManifestManager,
  type ManifestEntry,
} from '../manifest';

// ── Helpers ────────────────────────────────────────
const BASE_URL = 'https://vault.example.com';
const TOKEN = 'test-bearer-token';

/** 32-byte deterministic key for AES-256-GCM. */
const MASTER_KEY = new Uint8Array(32).fill(0x42);

function okJson<T>(body: T, headers: Record<string, string> = {}) {
  return { status: 200, json: body, headers, arrayBuffer: new ArrayBuffer(0) };
}

function okBinary(bytes: ArrayBuffer, headers: Record<string, string> = {}) {
  return { status: 200, json: null, headers, arrayBuffer: bytes };
}

function httpError(status: number, message = 'HTTP error') {
  return Object.assign(new Error(message), { status });
}

/** Serialize + encrypt a manifest object to the raw bytes the server would return. */
async function encryptManifest(
  obj: unknown,
  key: Uint8Array,
): Promise<ArrayBuffer> {
  const json = JSON.stringify(obj);
  const encrypted = await encryptBlob(new TextEncoder().encode(json), key);
  const buf = new ArrayBuffer(encrypted.byteLength);
  new Uint8Array(buf).set(encrypted);
  return buf;
}

function lastCall(): Record<string, unknown> {
  const calls = mockRequestUrl.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][0] as Record<string, unknown>;
}

function makeEntry(over: Partial<ManifestEntry> = {}): ManifestEntry {
  return {
    blobId: '11111111-1111-4111-8111-111111111111',
    size: 100,
    hash: 'abc123',
    modifiedAt: 1000,
    ...over,
  };
}

beforeEach(() => {
  mockRequestUrl.mockReset();
});

// ── load() ─────────────────────────────────────────
describe('ManifestManager — load', () => {
  it('starts empty with sequence 0 when the server has no manifest yet (404)', async () => {
    mockRequestUrl.mockRejectedValueOnce(httpError(404));
    const client = new VaultClient(BASE_URL, TOKEN);
    const mgr = new ManifestManager(client, MASTER_KEY);

    await mgr.load();

    expect(mgr.sequenceNumber).toBe(0);
    expect(mgr.getAllEntries().size).toBe(0);
  });

  it('decrypts the server manifest and populates entries', async () => {
    const serverManifest = {
      version: 1,
      entries: {
        'notes/daily.md': makeEntry({ hash: 'hash-a', size: 50 }),
        'ideas.md': makeEntry({ hash: 'hash-b', size: 80 }),
      },
    };
    const encrypted = await encryptManifest(serverManifest, MASTER_KEY);
    mockRequestUrl.mockResolvedValueOnce(
      okBinary(encrypted, { 'x-sequence-number': '7' }),
    );

    const client = new VaultClient(BASE_URL, TOKEN);
    const mgr = new ManifestManager(client, MASTER_KEY);
    await mgr.load();

    expect(mgr.sequenceNumber).toBe(7);
    expect(mgr.getEntry('notes/daily.md')?.hash).toBe('hash-a');
    expect(mgr.getEntry('ideas.md')?.hash).toBe('hash-b');
    expect(mgr.getAllEntries().size).toBe(2);
  });

  it('throws when decryption fails (wrong key or tampered data)', async () => {
    const serverManifest = { version: 1, entries: {} };
    const encrypted = await encryptManifest(serverManifest, MASTER_KEY);
    mockRequestUrl.mockResolvedValueOnce(
      okBinary(encrypted, { 'x-sequence-number': '1' }),
    );

    const wrongKey = new Uint8Array(32).fill(0x99);
    const client = new VaultClient(BASE_URL, TOKEN);
    const mgr = new ManifestManager(client, wrongKey);

    await expect(mgr.load()).rejects.toThrow();
  });
});

// ── save() ─────────────────────────────────────────
describe('ManifestManager — save', () => {
  it('encrypts and PUTs the manifest with the current sequence number', async () => {
    mockRequestUrl.mockRejectedValueOnce(httpError(404));
    const client = new VaultClient(BASE_URL, TOKEN);
    const mgr = new ManifestManager(client, MASTER_KEY);
    await mgr.load();

    mgr.setEntry('notes/a.md', makeEntry({ hash: 'fresh' }));
    mockRequestUrl.mockResolvedValueOnce(
      okJson({ ok: true, sequenceNumber: 1 }),
    );

    await mgr.save();

    const call = lastCall();
    expect(call.url).toBe(`${BASE_URL}/api/vault/manifest`);
    expect(call.method).toBe('PUT');
    expect(
      (call.headers as Record<string, string>)['X-Sequence-Number'],
    ).toBe('0');
    expect(mgr.sequenceNumber).toBe(1);
  });

  it('advances the sequence number on successful save', async () => {
    mockRequestUrl.mockRejectedValueOnce(httpError(404));
    const client = new VaultClient(BASE_URL, TOKEN);
    const mgr = new ManifestManager(client, MASTER_KEY);
    await mgr.load();

    mockRequestUrl.mockResolvedValueOnce(
      okJson({ ok: true, sequenceNumber: 5 }),
    );
    await mgr.save();
    expect(mgr.sequenceNumber).toBe(5);

    mockRequestUrl.mockResolvedValueOnce(
      okJson({ ok: true, sequenceNumber: 6 }),
    );
    await mgr.save();
    expect(mgr.sequenceNumber).toBe(6);
  });

  it('throws ManifestConflictError on 409 with server and client sequence numbers', async () => {
    mockRequestUrl.mockRejectedValueOnce(httpError(404));
    const client = new VaultClient(BASE_URL, TOKEN);
    const mgr = new ManifestManager(client, MASTER_KEY);
    await mgr.load();

    const conflictError = Object.assign(new Error('conflict'), {
      status: 409,
      json: {
        error: 'Manifest sequence conflict',
        serverSequence: 12,
        clientSequence: 0,
      },
    });
    mockRequestUrl.mockRejectedValueOnce(conflictError);

    let caught: unknown;
    try {
      await mgr.save();
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(ManifestConflictError);
    expect((caught as ManifestConflictError).serverSequence).toBe(12);
    expect((caught as ManifestConflictError).clientSequence).toBe(0);
  });

  it('round-trips entries through encrypt -> PUT -> GET -> decrypt', async () => {
    // First save: load empty, add an entry, save.
    mockRequestUrl.mockRejectedValueOnce(httpError(404));
    const client = new VaultClient(BASE_URL, TOKEN);
    const mgr = new ManifestManager(client, MASTER_KEY);
    await mgr.load();

    mgr.setEntry('hello.md', makeEntry({ hash: 'greetings' }));

    let capturedCiphertext: ArrayBuffer | undefined;
    mockRequestUrl.mockImplementationOnce(async (req: { body: ArrayBuffer }) => {
      capturedCiphertext = req.body;
      return okJson({ ok: true, sequenceNumber: 1 });
    });
    await mgr.save();

    // Second round: fresh manager loads what we just "saved".
    expect(capturedCiphertext).toBeDefined();
    mockRequestUrl.mockResolvedValueOnce(
      okBinary(capturedCiphertext!, { 'x-sequence-number': '1' }),
    );
    const mgr2 = new ManifestManager(client, MASTER_KEY);
    await mgr2.load();

    expect(mgr2.getEntry('hello.md')?.hash).toBe('greetings');
    expect(mgr2.sequenceNumber).toBe(1);
  });
});

// ── in-memory mutations ────────────────────────────
describe('ManifestManager — entries', () => {
  it('setEntry adds and updates; deleteEntry removes', async () => {
    mockRequestUrl.mockRejectedValueOnce(httpError(404));
    const client = new VaultClient(BASE_URL, TOKEN);
    const mgr = new ManifestManager(client, MASTER_KEY);
    await mgr.load();

    mgr.setEntry('a.md', makeEntry({ hash: 'v1' }));
    expect(mgr.getEntry('a.md')?.hash).toBe('v1');

    mgr.setEntry('a.md', makeEntry({ hash: 'v2' }));
    expect(mgr.getEntry('a.md')?.hash).toBe('v2');

    mgr.deleteEntry('a.md');
    expect(mgr.getEntry('a.md')).toBeUndefined();
  });

  it('getEntry returns undefined for unknown paths', async () => {
    mockRequestUrl.mockRejectedValueOnce(httpError(404));
    const client = new VaultClient(BASE_URL, TOKEN);
    const mgr = new ManifestManager(client, MASTER_KEY);
    await mgr.load();

    expect(mgr.getEntry('does-not-exist.md')).toBeUndefined();
  });

  it('deleteEntry is a no-op on unknown paths', async () => {
    mockRequestUrl.mockRejectedValueOnce(httpError(404));
    const client = new VaultClient(BASE_URL, TOKEN);
    const mgr = new ManifestManager(client, MASTER_KEY);
    await mgr.load();

    expect(() => mgr.deleteEntry('ghost.md')).not.toThrow();
  });
});

// ── diff() ─────────────────────────────────────────
describe('ManifestManager — diff', () => {
  async function loadWith(entries: Record<string, ManifestEntry>) {
    const encrypted = await encryptManifest(
      { version: 1, entries },
      MASTER_KEY,
    );
    mockRequestUrl.mockResolvedValueOnce(
      okBinary(encrypted, { 'x-sequence-number': '1' }),
    );
    const client = new VaultClient(BASE_URL, TOKEN);
    const mgr = new ManifestManager(client, MASTER_KEY);
    await mgr.load();
    return mgr;
  }

  it('flags new local files for upload', async () => {
    const mgr = await loadWith({});
    const local = new Map([['new.md', 'hash-new']]);

    const { toUpload, toDelete } = mgr.diff(local);

    expect(toUpload).toEqual(['new.md']);
    expect(toDelete).toEqual([]);
  });

  it('flags changed local files for upload when hash differs', async () => {
    const mgr = await loadWith({
      'doc.md': makeEntry({ hash: 'old-hash' }),
    });
    const local = new Map([['doc.md', 'new-hash']]);

    const { toUpload, toDelete } = mgr.diff(local);

    expect(toUpload).toEqual(['doc.md']);
    expect(toDelete).toEqual([]);
  });

  it('skips unchanged files', async () => {
    const mgr = await loadWith({
      'doc.md': makeEntry({ hash: 'same-hash' }),
    });
    const local = new Map([['doc.md', 'same-hash']]);

    const { toUpload, toDelete } = mgr.diff(local);

    expect(toUpload).toEqual([]);
    expect(toDelete).toEqual([]);
  });

  it('flags manifest entries not present locally for deletion', async () => {
    const mgr = await loadWith({
      'gone.md': makeEntry({ hash: 'whatever' }),
      'still-here.md': makeEntry({ hash: 'match' }),
    });
    const local = new Map([['still-here.md', 'match']]);

    const { toUpload, toDelete } = mgr.diff(local);

    expect(toUpload).toEqual([]);
    expect(toDelete).toEqual(['gone.md']);
  });
});
