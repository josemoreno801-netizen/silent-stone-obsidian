import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock `obsidian` ────────────────────────────────
// SilentStoneClient imports `requestUrl` from 'obsidian', provided by
// Obsidian at runtime and never bundled. Mock it so tests can control
// responses and inspect call arguments. Mirrors vault-client.test.ts.
const { mockRequestUrl } = vi.hoisted(() => ({
	mockRequestUrl: vi.fn(),
}));

vi.mock('obsidian', () => ({
	requestUrl: mockRequestUrl,
}));

import { SilentStoneClient } from '../client';
import type { FileEntry, FolderInfo, MeResponse, TokenResponse } from '../types';

// ── Helpers ────────────────────────────────────────
const BASE_URL = 'https://sync.example.com';
const TOKEN = 'syncthing-bearer-token-abc';

function okJson<T>(body: T, status = 200) {
	return { status, json: body, headers: {}, arrayBuffer: new ArrayBuffer(0) };
}

function lastCall(): Record<string, unknown> {
	const calls = mockRequestUrl.mock.calls;
	expect(calls.length).toBeGreaterThan(0);
	return calls[calls.length - 1][0] as Record<string, unknown>;
}

beforeEach(() => {
	mockRequestUrl.mockReset();
});

// ── Construction & token lifecycle ────────────────
describe('SilentStoneClient — construction', () => {
	it('strips a trailing slash from serverUrl', async () => {
		const client = new SilentStoneClient(`${BASE_URL}/`, TOKEN);
		mockRequestUrl.mockResolvedValueOnce(okJson<MeResponse>({
			nickname: 'tester',
			role: 'admin',
		}));

		await client.me();

		expect(lastCall().url).toBe(`${BASE_URL}/api/auth/me`);
	});

	it('leaves a slashless serverUrl untouched', async () => {
		const client = new SilentStoneClient(BASE_URL, TOKEN);
		mockRequestUrl.mockResolvedValueOnce(okJson<MeResponse>({
			nickname: 'tester',
			role: 'admin',
		}));

		await client.me();

		expect(lastCall().url).toBe(`${BASE_URL}/api/auth/me`);
	});

	it('setToken replaces the Bearer token used on subsequent requests', async () => {
		const client = new SilentStoneClient(BASE_URL, 'stale');
		client.setToken('fresh');
		mockRequestUrl.mockResolvedValueOnce(okJson<MeResponse>({
			nickname: 'tester',
			role: 'admin',
		}));

		await client.me();

		const headers = lastCall().headers as Record<string, string>;
		expect(headers.Authorization).toBe('Bearer fresh');
	});
});

// ── Auth endpoints ─────────────────────────────────
describe('SilentStoneClient — login', () => {
	it('POSTs to /api/auth/token with JSON body and no Bearer header', async () => {
		const client = new SilentStoneClient(BASE_URL, '');
		mockRequestUrl.mockResolvedValueOnce(okJson<TokenResponse>({
			ok: true,
			token: 'new-token-xyz',
		}));

		const result = await client.login('alice', 's3cret');

		const call = lastCall();
		expect(call.url).toBe(`${BASE_URL}/api/auth/token`);
		expect(call.method).toBe('POST');
		expect(call.body).toBe(JSON.stringify({ nickname: 'alice', password: 's3cret' }));
		const headers = call.headers as Record<string, string>;
		expect(headers['Content-Type']).toBe('application/json');
		expect(headers.Authorization).toBeUndefined();
		expect(result.token).toBe('new-token-xyz');
	});
});

describe('SilentStoneClient — me', () => {
	it('GETs /api/auth/me with Bearer + JSON Content-Type', async () => {
		const client = new SilentStoneClient(BASE_URL, TOKEN);
		mockRequestUrl.mockResolvedValueOnce(okJson<MeResponse>({
			nickname: 'bob',
			role: 'member',
		}));

		const me = await client.me();

		const call = lastCall();
		expect(call.method).toBe('GET');
		const headers = call.headers as Record<string, string>;
		expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
		expect(headers['Content-Type']).toBe('application/json');
		expect(me.nickname).toBe('bob');
		expect(me.role).toBe('member');
	});

	it('propagates a requestUrl rejection (401 etc.) to the caller', async () => {
		const client = new SilentStoneClient(BASE_URL, 'bad-token');
		const err = Object.assign(new Error('Unauthorized'), { status: 401 });
		mockRequestUrl.mockRejectedValueOnce(err);

		await expect(client.me()).rejects.toMatchObject({ status: 401 });
	});
});

// ── Folder endpoints ───────────────────────────────
describe('SilentStoneClient — folder operations', () => {
	it('listFolders GETs /api/folders with Bearer', async () => {
		const client = new SilentStoneClient(BASE_URL, TOKEN);
		const folders: FolderInfo[] = [
			{
				id: 'vault-a',
				label: 'Vault A',
				path: '/vault-a',
				type: 'sendreceive',
				encrypted: false,
				devices: [],
			},
		];
		mockRequestUrl.mockResolvedValueOnce(okJson(folders));

		const result = await client.listFolders();

		expect(lastCall().url).toBe(`${BASE_URL}/api/folders`);
		expect(result).toEqual(folders);
	});

	it('listFiles appends URL-encoded path query when provided', async () => {
		const client = new SilentStoneClient(BASE_URL, TOKEN);
		mockRequestUrl.mockResolvedValueOnce(okJson<FileEntry[]>([]));

		await client.listFiles('folder-1', 'notes/subfolder with space');

		expect(lastCall().url).toBe(
			`${BASE_URL}/api/folders/folder-1/files?path=${encodeURIComponent('notes/subfolder with space')}`,
		);
	});

	it('listFiles omits the query string when path is empty', async () => {
		const client = new SilentStoneClient(BASE_URL, TOKEN);
		mockRequestUrl.mockResolvedValueOnce(okJson<FileEntry[]>([]));

		await client.listFiles('folder-1');

		expect(lastCall().url).toBe(`${BASE_URL}/api/folders/folder-1/files`);
	});
});

// ── Health check ───────────────────────────────────
describe('SilentStoneClient — health', () => {
	it('returns true when server responds 200', async () => {
		const client = new SilentStoneClient(BASE_URL, TOKEN);
		mockRequestUrl.mockResolvedValueOnce(okJson({ ok: true }, 200));

		expect(await client.health()).toBe(true);
	});

	it('returns false when server responds non-200', async () => {
		const client = new SilentStoneClient(BASE_URL, TOKEN);
		mockRequestUrl.mockResolvedValueOnce(okJson({ ok: false }, 503));

		expect(await client.health()).toBe(false);
	});

	it('returns false when requestUrl throws (network error)', async () => {
		const client = new SilentStoneClient(BASE_URL, TOKEN);
		mockRequestUrl.mockRejectedValueOnce(new Error('connection refused'));

		expect(await client.health()).toBe(false);
	});

	it('health check omits Authorization header (public endpoint)', async () => {
		const client = new SilentStoneClient(BASE_URL, TOKEN);
		mockRequestUrl.mockResolvedValueOnce(okJson({ ok: true }, 200));

		await client.health();

		const call = lastCall();
		expect(call.headers).toBeUndefined();
	});
});
