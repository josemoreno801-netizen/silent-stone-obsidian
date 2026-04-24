import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock `obsidian` ────────────────────────────────
// SilentStoneSyncSettingTab extends PluginSettingTab and uses the Setting
// builder + Notice. We hand-roll the minimum surface it touches. The tab
// renders 9 Setting rows across 5 widget types: addText, addToggle,
// addSlider, addDropdown, addButton. Each captures its change handler so
// tests can drive the "Test connection" button and assert saveSettings is
// called on value changes.
const { MockPluginSettingTab, MockSetting, MockNotice, lastSettings } = vi.hoisted(() => {
	type FakeEl = {
		textContent: string;
		children: FakeEl[];
		cls: string[];
		createEl: (tag: string, opts?: { text?: string; cls?: string }) => FakeEl;
		empty: () => void;
	};

	function createFakeEl(): FakeEl {
		const el: FakeEl = {
			textContent: '',
			children: [],
			cls: [],
			createEl: (_tag, opts) => {
				const child = createFakeEl();
				if (opts?.text) child.textContent = opts.text;
				if (opts?.cls) {
					for (const c of opts.cls.split(/\s+/)) child.cls.push(c);
				}
				el.children.push(child);
				return child;
			},
			empty: () => {
				el.children = [];
				el.textContent = '';
			},
		};
		return el;
	}

	type Captured = {
		name: string;
		textOnChange?: (v: string) => void;
		toggleOnChange?: (v: boolean) => void;
		sliderOnChange?: (v: number) => void;
		dropdownOnChange?: (v: string) => void;
		buttonOnClick?: () => void | Promise<void>;
	};

	const allSettings: Captured[] = [];

	class MockPluginSettingTab {
		app: unknown;
		plugin: unknown;
		containerEl: FakeEl;

		constructor(app: unknown, plugin: unknown) {
			this.app = app;
			this.plugin = plugin;
			this.containerEl = createFakeEl();
		}
	}

	class MockSetting {
		private captured: Captured;

		constructor(_parent: unknown) {
			this.captured = { name: '' };
			allSettings.push(this.captured);
		}

		setName(n: string): this {
			this.captured.name = n;
			return this;
		}

		setDesc(_d: string): this {
			return this;
		}

		addText(cb: (t: unknown) => void): this {
			const api = {
				setPlaceholder: (_p: string) => api,
				setValue: (_v: string) => api,
				onChange: (fn: (v: string) => void) => {
					this.captured.textOnChange = fn;
					return api;
				},
			};
			cb(api);
			return this;
		}

		addToggle(cb: (t: unknown) => void): this {
			const api = {
				setValue: (_v: boolean) => api,
				onChange: (fn: (v: boolean) => void) => {
					this.captured.toggleOnChange = fn;
					return api;
				},
			};
			cb(api);
			return this;
		}

		addSlider(cb: (s: unknown) => void): this {
			const api = {
				setLimits: (_a: number, _b: number, _c: number) => api,
				setValue: (_v: number) => api,
				setDynamicTooltip: () => api,
				onChange: (fn: (v: number) => void) => {
					this.captured.sliderOnChange = fn;
					return api;
				},
			};
			cb(api);
			return this;
		}

		addDropdown(cb: (d: unknown) => void): this {
			const api = {
				addOption: (_value: string, _label: string) => api,
				setValue: (_v: string) => api,
				onChange: (fn: (v: string) => void) => {
					this.captured.dropdownOnChange = fn;
					return api;
				},
			};
			cb(api);
			return this;
		}

		addButton(cb: (b: unknown) => void): this {
			const api = {
				setButtonText: (_t: string) => api,
				setCta: () => api,
				onClick: (fn: () => void | Promise<void>) => {
					this.captured.buttonOnClick = fn;
					return api;
				},
			};
			cb(api);
			return this;
		}
	}

	const MockNotice = vi.fn();

	function lastSettings(): Captured[] {
		return allSettings;
	}

	return { MockPluginSettingTab, MockSetting, MockNotice, lastSettings };
});

vi.mock('obsidian', () => ({
	App: class {},
	PluginSettingTab: MockPluginSettingTab,
	Setting: MockSetting,
	Notice: MockNotice,
}));

// Mock SilentStoneClient so we can control health() / me() responses.
const { mockHealth, mockMe } = vi.hoisted(() => ({
	mockHealth: vi.fn(),
	mockMe: vi.fn(),
}));

vi.mock('../api/client', () => ({
	SilentStoneClient: class {
		health = mockHealth;
		me = mockMe;
		constructor(_serverUrl: string, _token: string) {}
	},
}));

import { SilentStoneSyncSettingTab } from '../settings';

// ── Test helpers ───────────────────────────────────
type VaultResult =
	| { kind: 'connected'; tier: string; usedBytes: number }
	| { kind: 'unauthorized' }
	| { kind: 'error'; message: string }
	| { kind: 'not-configured' };

type FakePlugin = {
	settings: {
		serverUrl: string;
		nickname: string;
		authToken: string;
		folderId: string;
		autoSync: boolean;
		syncInterval: number;
		syncOnStartup: boolean;
		conflictStrategy: 'ask' | 'keep-local' | 'keep-server' | 'keep-both';
		debugLogging: boolean;
	};
	saveSettings: ReturnType<typeof vi.fn>;
	checkVaultConnection: ReturnType<typeof vi.fn<() => Promise<VaultResult>>>;
};

function makePlugin(overrides: Partial<FakePlugin> = {}): FakePlugin {
	return {
		settings: {
			serverUrl: 'https://silentstone.one',
			nickname: 'tester',
			authToken: '',
			folderId: 'my-vault',
			autoSync: false,
			syncInterval: 5,
			syncOnStartup: false,
			conflictStrategy: 'ask',
			debugLogging: false,
		},
		saveSettings: vi.fn().mockResolvedValue(undefined),
		checkVaultConnection: vi.fn().mockResolvedValue({ kind: 'not-configured' }),
		...overrides,
	};
}

function openTab(plugin: FakePlugin): SilentStoneSyncSettingTab {
	const tab = new SilentStoneSyncSettingTab({} as never, plugin as never);
	tab.display();
	return tab;
}

function findByName(name: string) {
	return lastSettings().find((s) => s.name === name);
}

beforeEach(() => {
	lastSettings().length = 0;
	vi.clearAllMocks();
});

// ── Smoke: display builds all expected rows ────────
describe('SilentStoneSyncSettingTab — display()', () => {
	it('creates all 9 Setting rows without throwing', () => {
		const plugin = makePlugin();
		openTab(plugin);

		const names = lastSettings().map((s) => s.name);
		expect(names).toEqual([
			'Server URL',
			'Nickname',
			'Test connection',
			'Folder ID',
			'Auto-sync',
			'Sync interval',
			'Sync on startup',
			'Conflict resolution',
			'Debug logging',
		]);
	});

	it('persists via plugin.saveSettings when a text field changes', async () => {
		const plugin = makePlugin();
		openTab(plugin);

		const serverUrlRow = findByName('Server URL');
		expect(serverUrlRow?.textOnChange).toBeDefined();
		await serverUrlRow?.textOnChange?.('https://new.example.com');

		expect(plugin.saveSettings).toHaveBeenCalledOnce();
		expect(plugin.settings.serverUrl).toBe('https://new.example.com');
	});

	it('persists via plugin.saveSettings when auto-sync toggles', async () => {
		const plugin = makePlugin();
		openTab(plugin);

		const toggleRow = findByName('Auto-sync');
		await toggleRow?.toggleOnChange?.(true);

		expect(plugin.saveSettings).toHaveBeenCalledOnce();
		expect(plugin.settings.autoSync).toBe(true);
	});
});

// ── Test-connection button: four-branch handler ────
describe('SilentStoneSyncSettingTab — Test connection handler', () => {
	it('shows "Cannot reach server" when health check fails', async () => {
		const plugin = makePlugin();
		mockHealth.mockResolvedValueOnce(false);
		openTab(plugin);

		await findByName('Test connection')?.buttonOnClick?.();

		expect(MockNotice).toHaveBeenCalledWith('Cannot reach server. Check the URL.');
		expect(plugin.checkVaultConnection).not.toHaveBeenCalled();
	});

	it('shows vault-connected notice with tier and MB used', async () => {
		const plugin = makePlugin({
			checkVaultConnection: vi.fn().mockResolvedValue({
				kind: 'connected',
				tier: 'pro',
				usedBytes: 2 * 1024 * 1024 + 500 * 1024,
			}),
		});
		mockHealth.mockResolvedValueOnce(true);
		openTab(plugin);

		await findByName('Test connection')?.buttonOnClick?.();

		expect(MockNotice).toHaveBeenCalledWith(
			expect.stringMatching(/Vault connected \(tier: pro, 2\.5 MB used\)/),
		);
	});

	it('shows "Vault token expired" notice on unauthorized', async () => {
		const plugin = makePlugin({
			checkVaultConnection: vi.fn().mockResolvedValue({ kind: 'unauthorized' }),
		});
		mockHealth.mockResolvedValueOnce(true);
		openTab(plugin);

		await findByName('Test connection')?.buttonOnClick?.();

		expect(MockNotice).toHaveBeenCalledWith(
			expect.stringContaining('Vault token expired or revoked'),
		);
	});

	it('shows vault error message on error kind', async () => {
		const plugin = makePlugin({
			checkVaultConnection: vi.fn().mockResolvedValue({
				kind: 'error',
				message: 'server 500',
			}),
		});
		mockHealth.mockResolvedValueOnce(true);
		openTab(plugin);

		await findByName('Test connection')?.buttonOnClick?.();

		expect(MockNotice).toHaveBeenCalledWith('Vault check failed: server 500');
	});

	it('falls through to Syncthing me() when vault not-configured and authToken present', async () => {
		const plugin = makePlugin({
			settings: {
				...makePlugin().settings,
				authToken: 'syncthing-token',
			},
			checkVaultConnection: vi.fn().mockResolvedValue({ kind: 'not-configured' }),
		});
		mockHealth.mockResolvedValueOnce(true);
		mockMe.mockResolvedValueOnce({ nickname: 'alice', role: 'admin' });
		openTab(plugin);

		await findByName('Test connection')?.buttonOnClick?.();

		expect(mockMe).toHaveBeenCalledOnce();
		expect(MockNotice).toHaveBeenCalledWith('Connected as alice (admin)');
	});

	it('shows setup hint when vault not-configured and no authToken', async () => {
		const plugin = makePlugin({
			checkVaultConnection: vi.fn().mockResolvedValue({ kind: 'not-configured' }),
		});
		mockHealth.mockResolvedValueOnce(true);
		openTab(plugin);

		await findByName('Test connection')?.buttonOnClick?.();

		expect(mockMe).not.toHaveBeenCalled();
		expect(MockNotice).toHaveBeenCalledWith(
			expect.stringContaining('Run "Vault: first-time setup"'),
		);
	});
});
