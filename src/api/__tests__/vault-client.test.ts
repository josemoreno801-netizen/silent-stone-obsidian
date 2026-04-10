import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock `obsidian` ────────────────────────────────
// VaultClient imports `requestUrl` from 'obsidian', which is provided by
// Obsidian at runtime and never bundled. We mock it so tests can control
// responses and inspect call arguments.
//
// The factory uses a hoisted holder (via vi.hoisted) because vi.mock
// factories are hoisted above imports — we can't reference module-scoped
// variables directly.
const { mockRequestUrl } = vi.hoisted(() => ({
  mockRequestUrl: vi.fn(),
}));

vi.mock('obsidian', () => ({
  requestUrl: mockRequestUrl,
}));

import { VaultClient } from '../vault-client';
import type {
  BatchBlobEntry,
  BatchUploadResponse,
  BlobDeleteResponse,
  BlobUploadResponse,
  ManifestPutResponse,
  VaultKeyParams,
  VaultKeySetupResponse,
  VaultKeyUpdateResponse,
  VaultStatusResponse,
  VaultTokenResponse,
} from '../vault-types';

// ── Helpers ────────────────────────────────────────
const BASE_URL = 'https://vault.example.com';
const TOKEN = 'test-bearer-token-abc123';

/** Build a fake successful requestUrl response with JSON. */
function okJson<T>(body: T, headers: Record<string, string> = {}) {
  return { status: 200, json: body, headers, arrayBuffer: new ArrayBuffer(0) };
}

/** Build a fake successful requestUrl response with binary. */
function okBinary(bytes: ArrayBuffer, headers: Record<string, string> = {}) {
  return { status: 200, json: null, headers, arrayBuffer: bytes };
}

/**
 * Build a thrown error matching Obsidian's requestUrl shape.
 * requestUrl rejects with an object that has a `status` field on non-2xx.
 */
function httpError(status: number, message = 'HTTP error') {
  return Object.assign(new Error(message), { status });
}

/** Return the most recent requestUrl call arguments. */
function lastCall(): Record<string, unknown> {
  const calls = mockRequestUrl.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][0] as Record<string, unknown>;
}

beforeEach(() => {
  mockRequestUrl.mockReset();
});

// ── Construction & token lifecycle ─────────────────
describe('VaultClient — construction & token lifecycle', () => {
  it('strips a single trailing slash from baseUrl', async () => {
    const client = new VaultClient(`${BASE_URL}/`, TOKEN);
    mockRequestUrl.mockResolvedValueOnce(
      okJson<VaultStatusResponse>({
        storageUsedBytes: 0,
        storageLimitBytes: 1000,
        tier: 'free',
        lastSyncAt: null,
        manifestSeq: 0,
        keysConfigured: false,
        suspended: false,
      }),
    );
    await client.getStatus();
    expect(lastCall().url).toBe(`${BASE_URL}/api/vault/status`);
  });

  it('strips multiple trailing slashes from baseUrl', async () => {
    const client = new VaultClient(`${BASE_URL}///`, TOKEN);
    mockRequestUrl.mockResolvedValueOnce(okJson({ ok: true }));
    await client.getStatus();
    expect(lastCall().url).toBe(`${BASE_URL}/api/vault/status`);
  });

  it('setToken updates the Bearer header on subsequent calls', async () => {
    const client = new VaultClient(BASE_URL, 'old-token');

    mockRequestUrl.mockResolvedValueOnce(okJson({ ok: true }));
    await client.getStatus();
    expect(
      (lastCall().headers as Record<string, string>).Authorization,
    ).toBe('Bearer old-token');

    client.setToken('new-token');
    mockRequestUrl.mockResolvedValueOnce(okJson({ ok: true }));
    await client.getStatus();
    expect(
      (lastCall().headers as Record<string, string>).Authorization,
    ).toBe('Bearer new-token');
  });
});

// ── Token endpoint ─────────────────────────────────
describe('VaultClient.createToken', () => {
  it('POSTs JSON body and returns typed VaultTokenResponse', async () => {
    const client = new VaultClient(BASE_URL, '');
    const response: VaultTokenResponse = {
      token: 'new-token',
      nickname: 'alice',
      expiresAt: 1_700_000_000,
      label: 'laptop',
    };
    mockRequestUrl.mockResolvedValueOnce(okJson(response));

    const result = await client.createToken({
      nickname: 'alice',
      password: 'hunter2',
      label: 'laptop',
    });

    expect(result).toEqual(response);
    const call = lastCall();
    expect(call.url).toBe(`${BASE_URL}/api/vault/token`);
    expect(call.method).toBe('POST');
    expect((call.headers as Record<string, string>)['Content-Type']).toBe(
      'application/json',
    );
    // Public endpoint — must NOT send a Bearer (even if we happen to have one)
    expect(
      (call.headers as Record<string, string>).Authorization,
    ).toBeUndefined();
    expect(JSON.parse(call.body as string)).toEqual({
      nickname: 'alice',
      password: 'hunter2',
      label: 'laptop',
    });
  });

  it('surfaces a typed error on non-2xx (requestUrl rejects)', async () => {
    const client = new VaultClient(BASE_URL, '');
    mockRequestUrl.mockRejectedValueOnce(httpError(401, 'Unauthorized'));

    await expect(
      client.createToken({ nickname: 'alice', password: 'wrong' }),
    ).rejects.toMatchObject({ status: 401 });
  });
});

// ── Status endpoint ────────────────────────────────
describe('VaultClient.getStatus', () => {
  it('GETs with Bearer header and returns typed VaultStatusResponse', async () => {
    const client = new VaultClient(BASE_URL, TOKEN);
    const response: VaultStatusResponse = {
      storageUsedBytes: 1234,
      storageLimitBytes: 52_428_800,
      tier: 'free',
      lastSyncAt: '2026-04-10T00:00:00Z',
      manifestSeq: 7,
      keysConfigured: true,
      suspended: false,
    };
    mockRequestUrl.mockResolvedValueOnce(okJson(response));

    const result = await client.getStatus();
    expect(result).toEqual(response);
    const call = lastCall();
    expect(call.url).toBe(`${BASE_URL}/api/vault/status`);
    expect(call.method).toBe('GET');
    expect(
      (call.headers as Record<string, string>).Authorization,
    ).toBe(`Bearer ${TOKEN}`);
  });

  it('propagates 401 errors from the server', async () => {
    const client = new VaultClient(BASE_URL, TOKEN);
    mockRequestUrl.mockRejectedValueOnce(httpError(401));
    await expect(client.getStatus()).rejects.toMatchObject({ status: 401 });
  });

  it('propagates 404 errors from the server', async () => {
    const client = new VaultClient(BASE_URL, TOKEN);
    mockRequestUrl.mockRejectedValueOnce(httpError(404));
    await expect(client.getStatus()).rejects.toMatchObject({ status: 404 });
  });
});

// ── Manifest endpoints ─────────────────────────────
describe('VaultClient.getManifest', () => {
  it('returns ArrayBuffer and parses x-sequence-number header', async () => {
    const client = new VaultClient(BASE_URL, TOKEN);
    const payload = new Uint8Array([1, 2, 3, 4]).buffer;
    mockRequestUrl.mockResolvedValueOnce(
      okBinary(payload, { 'x-sequence-number': '42' }),
    );

    const result = await client.getManifest();
    expect(result).not.toBeNull();
    expect(result!.data).toBe(payload);
    expect(result!.sequenceNumber).toBe(42);

    const call = lastCall();
    expect(call.url).toBe(`${BASE_URL}/api/vault/manifest`);
    expect(call.method).toBe('GET');
    expect(
      (call.headers as Record<string, string>).Authorization,
    ).toBe(`Bearer ${TOKEN}`);
  });

  it('defaults sequenceNumber to 0 when header is missing', async () => {
    const client = new VaultClient(BASE_URL, TOKEN);
    mockRequestUrl.mockResolvedValueOnce(okBinary(new ArrayBuffer(0), {}));
    const result = await client.getManifest();
    expect(result!.sequenceNumber).toBe(0);
  });

  it('returns null on 404 (no manifest yet)', async () => {
    const client = new VaultClient(BASE_URL, TOKEN);
    mockRequestUrl.mockRejectedValueOnce(httpError(404));
    const result = await client.getManifest();
    expect(result).toBeNull();
  });

  it('rethrows non-404 errors', async () => {
    const client = new VaultClient(BASE_URL, TOKEN);
    mockRequestUrl.mockRejectedValueOnce(httpError(500, 'Internal'));
    await expect(client.getManifest()).rejects.toMatchObject({ status: 500 });
  });
});

describe('VaultClient.putManifest', () => {
  it('PUTs binary body with octet-stream Content-Type and X-Sequence-Number', async () => {
    const client = new VaultClient(BASE_URL, TOKEN);
    const data = new Uint8Array([9, 8, 7]).buffer;
    const response: ManifestPutResponse = { ok: true, sequenceNumber: 5 };
    mockRequestUrl.mockResolvedValueOnce(okJson(response));

    const result = await client.putManifest(data, 4);
    expect(result).toEqual(response);

    const call = lastCall();
    expect(call.url).toBe(`${BASE_URL}/api/vault/manifest`);
    expect(call.method).toBe('PUT');
    const headers = call.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers['Content-Type']).toBe('application/octet-stream');
    expect(headers['X-Sequence-Number']).toBe('4');
    expect(call.body).toBe(data);
  });

  it('surfaces a 409 conflict error (optimistic concurrency)', async () => {
    const client = new VaultClient(BASE_URL, TOKEN);
    mockRequestUrl.mockRejectedValueOnce(httpError(409, 'Sequence conflict'));
    await expect(
      client.putManifest(new ArrayBuffer(0), 0),
    ).rejects.toMatchObject({ status: 409 });
  });
});

// ── Blob endpoints ─────────────────────────────────
describe('VaultClient.putBlob', () => {
  it('PUTs binary body with octet-stream Content-Type and Bearer', async () => {
    const client = new VaultClient(BASE_URL, TOKEN);
    const blobId = '11111111-2222-4333-8444-555555555555';
    const data = new Uint8Array([10, 20, 30]).buffer;
    const response: BlobUploadResponse = {
      ok: true,
      blobId,
      size: 3,
    };
    mockRequestUrl.mockResolvedValueOnce(okJson(response));

    const result = await client.putBlob(blobId, data);
    expect(result).toEqual(response);

    const call = lastCall();
    expect(call.url).toBe(`${BASE_URL}/api/vault/blobs/${blobId}`);
    expect(call.method).toBe('PUT');
    const headers = call.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers['Content-Type']).toBe('application/octet-stream');
    expect(call.body).toBe(data);
  });

  it('propagates 413 quota-exceeded errors', async () => {
    const client = new VaultClient(BASE_URL, TOKEN);
    mockRequestUrl.mockRejectedValueOnce(httpError(413, 'Quota exceeded'));
    await expect(
      client.putBlob('id', new ArrayBuffer(100)),
    ).rejects.toMatchObject({ status: 413 });
  });
});

describe('VaultClient.getBlob', () => {
  it('GETs blob by ID and returns the raw ArrayBuffer', async () => {
    const client = new VaultClient(BASE_URL, TOKEN);
    const blobId = 'abc';
    const bytes = new Uint8Array([5, 6, 7, 8]).buffer;
    mockRequestUrl.mockResolvedValueOnce(okBinary(bytes));

    const result = await client.getBlob(blobId);
    expect(result).toBe(bytes);

    const call = lastCall();
    expect(call.url).toBe(`${BASE_URL}/api/vault/blobs/${blobId}`);
    expect(call.method).toBe('GET');
    expect(
      (call.headers as Record<string, string>).Authorization,
    ).toBe(`Bearer ${TOKEN}`);
  });

  it('propagates 404 errors (caller decides what to do)', async () => {
    const client = new VaultClient(BASE_URL, TOKEN);
    mockRequestUrl.mockRejectedValueOnce(httpError(404));
    await expect(client.getBlob('missing')).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('VaultClient.deleteBlob', () => {
  /**
   * REGRESSION SHIELD for commit f17debd:
   * "fix(plugin): add Content-Type header to deleteBlob for CSRF bypass"
   *
   * Bodiless DELETE requests return 403 behind Caddy without a
   * Content-Type header. This test locks in the fix.
   */
  it('sends Content-Type: application/json header (CSRF bypass regression shield)', async () => {
    const client = new VaultClient(BASE_URL, TOKEN);
    const response: BlobDeleteResponse = { ok: true };
    mockRequestUrl.mockResolvedValueOnce(okJson(response));

    await client.deleteBlob('some-blob-id');

    const call = lastCall();
    const headers = call.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('DELETEs blob by ID and returns the typed response', async () => {
    const client = new VaultClient(BASE_URL, TOKEN);
    const blobId = 'delete-me';
    const response: BlobDeleteResponse = { ok: true };
    mockRequestUrl.mockResolvedValueOnce(okJson(response));

    const result = await client.deleteBlob(blobId);
    expect(result).toEqual(response);
    const call = lastCall();
    expect(call.url).toBe(`${BASE_URL}/api/vault/blobs/${blobId}`);
    expect(call.method).toBe('DELETE');
  });

  it('propagates 500 errors', async () => {
    const client = new VaultClient(BASE_URL, TOKEN);
    mockRequestUrl.mockRejectedValueOnce(httpError(500));
    await expect(client.deleteBlob('id')).rejects.toMatchObject({
      status: 500,
    });
  });
});

// ── Batch upload ───────────────────────────────────
describe('VaultClient.batchUpload', () => {
  it('POSTs { blobs: [...] } JSON body and returns typed response', async () => {
    const client = new VaultClient(BASE_URL, TOKEN);
    const entries: BatchBlobEntry[] = [
      { id: 'a', data: 'QUJDRA==' },
      { id: 'b', data: 'RUZHSA==' },
    ];
    const response: BatchUploadResponse = {
      ok: true,
      uploaded: ['a', 'b'],
      totalSize: 8,
    };
    mockRequestUrl.mockResolvedValueOnce(okJson(response));

    const result = await client.batchUpload(entries);
    expect(result).toEqual(response);

    const call = lastCall();
    expect(call.url).toBe(`${BASE_URL}/api/vault/blobs/batch`);
    expect(call.method).toBe('POST');
    const headers = call.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers['Content-Type']).toBe('application/json');
    // The client wraps the array in { blobs } — regression shield against
    // accidentally posting the raw array.
    expect(JSON.parse(call.body as string)).toEqual({ blobs: entries });
  });

  it('handles an empty batch (server decides policy)', async () => {
    const client = new VaultClient(BASE_URL, TOKEN);
    const response: BatchUploadResponse = {
      ok: true,
      uploaded: [],
      totalSize: 0,
    };
    mockRequestUrl.mockResolvedValueOnce(okJson(response));

    const result = await client.batchUpload([]);
    expect(result.uploaded).toEqual([]);
    expect(JSON.parse(lastCall().body as string)).toEqual({ blobs: [] });
  });

  it('propagates 413 quota-exceeded errors on batch', async () => {
    const client = new VaultClient(BASE_URL, TOKEN);
    mockRequestUrl.mockRejectedValueOnce(httpError(413));
    await expect(
      client.batchUpload([{ id: 'a', data: 'QUE=' }]),
    ).rejects.toMatchObject({ status: 413 });
  });
});

// ── Keys endpoints ─────────────────────────────────
const FAKE_KEY_PARAMS: VaultKeyParams = {
  encryptedMasterKey: 'ZW5jcnlwdGVk',
  salt: 'c2FsdA==',
  argon2Memory: 65_536,
  argon2Time: 3,
  argon2Parallelism: 4,
};

describe('VaultClient.setupKeys', () => {
  it('POSTs params as JSON with Bearer and returns typed response', async () => {
    const client = new VaultClient(BASE_URL, TOKEN);
    const response: VaultKeySetupResponse = { ok: true };
    mockRequestUrl.mockResolvedValueOnce(okJson(response));

    const result = await client.setupKeys(FAKE_KEY_PARAMS);
    expect(result).toEqual(response);

    const call = lastCall();
    expect(call.url).toBe(`${BASE_URL}/api/vault/keys/setup`);
    expect(call.method).toBe('POST');
    const headers = call.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(call.body as string)).toEqual(FAKE_KEY_PARAMS);
  });

  it('propagates 409 when keys already exist', async () => {
    const client = new VaultClient(BASE_URL, TOKEN);
    mockRequestUrl.mockRejectedValueOnce(httpError(409, 'Keys already exist'));
    await expect(client.setupKeys(FAKE_KEY_PARAMS)).rejects.toMatchObject({
      status: 409,
    });
  });
});

describe('VaultClient.getKeys', () => {
  it('GETs with Bearer and returns typed VaultKeyParams', async () => {
    const client = new VaultClient(BASE_URL, TOKEN);
    mockRequestUrl.mockResolvedValueOnce(okJson(FAKE_KEY_PARAMS));

    const result = await client.getKeys();
    expect(result).toEqual(FAKE_KEY_PARAMS);
    const call = lastCall();
    expect(call.url).toBe(`${BASE_URL}/api/vault/keys`);
    expect(call.method).toBe('GET');
    expect(
      (call.headers as Record<string, string>).Authorization,
    ).toBe(`Bearer ${TOKEN}`);
  });

  it('returns null on 404 (keys not configured)', async () => {
    const client = new VaultClient(BASE_URL, TOKEN);
    mockRequestUrl.mockRejectedValueOnce(httpError(404));
    const result = await client.getKeys();
    expect(result).toBeNull();
  });

  it('rethrows non-404 errors', async () => {
    const client = new VaultClient(BASE_URL, TOKEN);
    mockRequestUrl.mockRejectedValueOnce(httpError(401));
    await expect(client.getKeys()).rejects.toMatchObject({ status: 401 });
  });
});

describe('VaultClient.updateKeys', () => {
  it('PUTs params as JSON with Bearer and returns typed response', async () => {
    const client = new VaultClient(BASE_URL, TOKEN);
    const response: VaultKeyUpdateResponse = { ok: true };
    mockRequestUrl.mockResolvedValueOnce(okJson(response));

    const result = await client.updateKeys(FAKE_KEY_PARAMS);
    expect(result).toEqual(response);

    const call = lastCall();
    expect(call.url).toBe(`${BASE_URL}/api/vault/keys`);
    expect(call.method).toBe('PUT');
    const headers = call.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(call.body as string)).toEqual(FAKE_KEY_PARAMS);
  });

  it('propagates 404 when keys not yet set up', async () => {
    const client = new VaultClient(BASE_URL, TOKEN);
    mockRequestUrl.mockRejectedValueOnce(httpError(404));
    await expect(client.updateKeys(FAKE_KEY_PARAMS)).rejects.toMatchObject({
      status: 404,
    });
  });
});

// ── Health endpoint ────────────────────────────────
describe('VaultClient.health', () => {
  it('returns true on 200 OK', async () => {
    const client = new VaultClient(BASE_URL, TOKEN);
    mockRequestUrl.mockResolvedValueOnce(okJson({ status: 'ok' }));
    expect(await client.health()).toBe(true);
    const call = lastCall();
    expect(call.url).toBe(`${BASE_URL}/api/health`);
    expect(call.method).toBe('GET');
    // Public endpoint — no Bearer required
    expect(call.headers).toBeUndefined();
  });

  it('returns false on non-200 status', async () => {
    const client = new VaultClient(BASE_URL, TOKEN);
    mockRequestUrl.mockResolvedValueOnce({
      status: 503,
      json: null,
      headers: {},
      arrayBuffer: new ArrayBuffer(0),
    });
    expect(await client.health()).toBe(false);
  });

  it('returns false when the request throws (network down)', async () => {
    const client = new VaultClient(BASE_URL, TOKEN);
    mockRequestUrl.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect(await client.health()).toBe(false);
  });
});

// ── Cross-cutting: Bearer header regression shield ──
describe('VaultClient — Bearer header on authenticated calls', () => {
  it.each([
    ['getStatus', async (c: VaultClient) => c.getStatus()],
    ['getManifest', async (c: VaultClient) => c.getManifest()],
    [
      'putManifest',
      async (c: VaultClient) => c.putManifest(new ArrayBuffer(0), 0),
    ],
    ['getBlob', async (c: VaultClient) => c.getBlob('id')],
    ['putBlob', async (c: VaultClient) => c.putBlob('id', new ArrayBuffer(0))],
    ['deleteBlob', async (c: VaultClient) => c.deleteBlob('id')],
    ['batchUpload', async (c: VaultClient) => c.batchUpload([])],
    ['setupKeys', async (c: VaultClient) => c.setupKeys(FAKE_KEY_PARAMS)],
    ['getKeys', async (c: VaultClient) => c.getKeys()],
    ['updateKeys', async (c: VaultClient) => c.updateKeys(FAKE_KEY_PARAMS)],
  ])('%s sends the Bearer header', async (_name, invoke) => {
    const client = new VaultClient(BASE_URL, TOKEN);
    mockRequestUrl.mockResolvedValueOnce(
      okJson({ ok: true }, { 'x-sequence-number': '0' }),
    );
    await invoke(client);
    expect(
      (lastCall().headers as Record<string, string>).Authorization,
    ).toBe(`Bearer ${TOKEN}`);
  });
});
