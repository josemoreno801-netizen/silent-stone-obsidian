import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock `obsidian` ────────────────────────────────
// Hand-rolled mocks for the Obsidian Setting builder + PluginSettingTab. The
// production code exercises addText, addToggle, addSlider, addDropdown,
// addButton (with multiple buttons per Setting), setWarning, setTooltip, and
// setCta. The mock captures every change/click handler so tests can drive them.
const { MockPluginSettingTab, MockSetting, MockNotice, capturedSettings } = vi.hoisted(
  () => {
    type FakeEl = {
      textContent: string;
      cls: string[];
      children: FakeEl[];
      createEl: (tag: string, opts?: { text?: string; cls?: string }) => FakeEl;
      createDiv: (opts?: { text?: string; cls?: string }) => FakeEl;
      createSpan: (opts?: { text?: string; cls?: string }) => FakeEl;
      empty: () => void;
      setText: (s: string) => void;
    };

    function createFakeEl(): FakeEl {
      const el: FakeEl = {
        textContent: '',
        cls: [],
        children: [],
        createEl: (_tag, opts) => {
          const child = createFakeEl();
          if (opts?.text) child.textContent = opts.text;
          if (opts?.cls) child.cls.push(...opts.cls.split(/\s+/));
          el.children.push(child);
          return child;
        },
        createDiv: (opts) => {
          const child = createFakeEl();
          if (opts?.text) child.textContent = opts.text;
          if (opts?.cls) child.cls.push(...opts.cls.split(/\s+/));
          el.children.push(child);
          return child;
        },
        createSpan: (opts) => {
          const child = createFakeEl();
          if (opts?.text) child.textContent = opts.text;
          if (opts?.cls) child.cls.push(...opts.cls.split(/\s+/));
          el.children.push(child);
          return child;
        },
        empty: () => {
          el.children = [];
          el.textContent = '';
        },
        setText: (s: string) => {
          el.textContent = s;
        },
      };
      return el;
    }

    type Captured = {
      name: string;
      desc: string;
      textOnChange?: (v: string) => void | Promise<void>;
      toggleOnChange?: (v: boolean) => void | Promise<void>;
      sliderOnChange?: (v: number) => void | Promise<void>;
      dropdownOnChange?: (v: string) => void | Promise<void>;
      buttonClicks: Array<{ label?: string; onClick: () => void | Promise<void> }>;
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
      hide(): void {
        // base class no-op; subclass may call super.hide()
      }
    }

    class MockSetting {
      private captured: Captured;
      constructor(_parent: unknown) {
        this.captured = { name: '', desc: '', buttonClicks: [] };
        allSettings.push(this.captured);
      }
      setName(n: string): this {
        this.captured.name = n;
        return this;
      }
      setDesc(d: string): this {
        this.captured.desc = d;
        return this;
      }
      addText(cb: (t: unknown) => void): this {
        const api = {
          setPlaceholder: (_p: string) => api,
          setValue: (_v: string) => api,
          onChange: (fn: (v: string) => void | Promise<void>) => {
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
          onChange: (fn: (v: boolean) => void | Promise<void>) => {
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
          onChange: (fn: (v: number) => void | Promise<void>) => {
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
          onChange: (fn: (v: string) => void | Promise<void>) => {
            this.captured.dropdownOnChange = fn;
            return api;
          },
        };
        cb(api);
        return this;
      }
      addButton(cb: (b: unknown) => void): this {
        const buttonState: { label?: string; onClick: () => void | Promise<void> } = {
          onClick: () => undefined,
        };
        const api = {
          setButtonText: (t: string) => {
            buttonState.label = t;
            return api;
          },
          setCta: () => api,
          setWarning: () => api,
          setTooltip: (_t: string) => api,
          onClick: (fn: () => void | Promise<void>) => {
            buttonState.onClick = fn;
            return api;
          },
        };
        cb(api);
        this.captured.buttonClicks.push(buttonState);
        return this;
      }
    }

    const MockNotice = vi.fn();

    return {
      MockPluginSettingTab,
      MockSetting,
      MockNotice,
      capturedSettings: allSettings,
    };
  },
);

vi.mock('obsidian', () => ({
  App: class {},
  PluginSettingTab: MockPluginSettingTab,
  Setting: MockSetting,
  Notice: MockNotice,
}));

vi.mock('../api/client', () => ({
  SilentStoneClient: class {
    health = vi.fn().mockResolvedValue(true);
    me = vi.fn().mockResolvedValue({ nickname: 'tester', role: 'member' });
    constructor(_serverUrl: string, _token: string) {}
  },
}));

import { SilentStoneSyncSettingTab, formatRelativeTime, formatBytes } from '../settings';
import type { PersistedSyncMetrics, SyncStatus, SyncStatusEvent } from '../types';

// ── Test helpers ───────────────────────────────────
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
    developerMode: boolean;
  };
  status: SyncStatus;
  lastSyncMetrics: PersistedSyncMetrics;
  vaultClient: { getStatus: ReturnType<typeof vi.fn> } | null;
  saveSettings: ReturnType<typeof vi.fn>;
  triggerVaultSync: ReturnType<typeof vi.fn>;
  lockVault: ReturnType<typeof vi.fn>;
  openDashboard: ReturnType<typeof vi.fn>;
  addStatusListener: (l: (e: SyncStatusEvent) => void) => () => void;
  // Holds the most recently registered status listener so tests can fire events.
  __lastStatusListener?: (e: SyncStatusEvent) => void;
};

function makePlugin(overrides: Partial<FakePlugin> = {}): FakePlugin {
  const plugin: FakePlugin = {
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
      developerMode: false,
    },
    status: 'idle',
    lastSyncMetrics: {},
    vaultClient: null,
    saveSettings: vi.fn().mockResolvedValue(undefined),
    triggerVaultSync: vi.fn().mockResolvedValue(undefined),
    lockVault: vi.fn(),
    openDashboard: vi.fn(),
    addStatusListener: function (l: (e: SyncStatusEvent) => void) {
      this.__lastStatusListener = l;
      return () => {
        if (this.__lastStatusListener === l) this.__lastStatusListener = undefined;
      };
    },
    ...overrides,
  };
  return plugin;
}

function openTab(plugin: FakePlugin): SilentStoneSyncSettingTab {
  const tab = new SilentStoneSyncSettingTab({} as never, plugin as never);
  tab.display();
  return tab;
}

function findByName(name: string) {
  return capturedSettings.find((s) => s.name === name);
}

function buttonByLabel(
  setting: { buttonClicks: Array<{ label?: string; onClick: () => void | Promise<void> }> },
  label: string,
) {
  return setting.buttonClicks.find((b) => b.label === label);
}

beforeEach(() => {
  capturedSettings.length = 0;
  vi.clearAllMocks();
});

// ── Default mode: section structure ───────────────
describe('SilentStoneSyncSettingTab — default (non-developer) mode', () => {
  it('renders Account, Vault, Sync, Conflict sections + Developer toggle without throwing', () => {
    const plugin = makePlugin();
    openTab(plugin);

    const names = capturedSettings.map((s) => s.name);
    // Expected rows in default mode: Nickname (account), Sync now (vault),
    // Auto-sync, Sync interval, Sync on startup (sync), On conflict (conflict),
    // Developer mode (toggle).
    expect(names).toEqual([
      'Nickname',
      'Sync now',
      'Auto-sync',
      'Sync interval',
      'Sync on startup',
      'On conflict',
      'Developer mode',
    ]);
  });

  it('does NOT render Server URL, Folder ID, or legacy Syncthing fields by default', () => {
    const plugin = makePlugin();
    openTab(plugin);

    expect(findByName('Server URL')).toBeUndefined();
    expect(findByName('Folder ID')).toBeUndefined();
    expect(findByName('Test Syncthing connection')).toBeUndefined();
    expect(findByName('Debug logging')).toBeUndefined();
  });
});

// ── Account section actions ───────────────────────
describe('SilentStoneSyncSettingTab — Account section', () => {
  it('Open dashboard button calls plugin.openDashboard', async () => {
    const plugin = makePlugin();
    openTab(plugin);

    const nicknameRow = findByName('Nickname');
    const openBtn = buttonByLabel(nicknameRow!, 'Open dashboard');
    expect(openBtn).toBeDefined();
    await openBtn!.onClick();

    expect(plugin.openDashboard).toHaveBeenCalledOnce();
  });

  it('Lock vault button calls plugin.lockVault', async () => {
    const plugin = makePlugin();
    openTab(plugin);

    const nicknameRow = findByName('Nickname');
    const lockBtn = buttonByLabel(nicknameRow!, 'Lock vault');
    expect(lockBtn).toBeDefined();
    await lockBtn!.onClick();

    expect(plugin.lockVault).toHaveBeenCalledOnce();
  });

  it('shows nickname in description when signed in', () => {
    const plugin = makePlugin({
      settings: { ...makePlugin().settings, nickname: 'alice' },
    });
    openTab(plugin);
    const row = findByName('Nickname');
    expect(row?.desc).toBe('alice');
  });

  it('shows sign-in hint in description when nickname is empty', () => {
    const plugin = makePlugin({
      settings: { ...makePlugin().settings, nickname: '' },
    });
    openTab(plugin);
    const row = findByName('Nickname');
    expect(row?.desc).toContain('Not signed in');
  });
});

// ── Vault section: Sync Now button + status panel listener ────
describe('SilentStoneSyncSettingTab — Vault section', () => {
  it('Sync now button calls plugin.triggerVaultSync', async () => {
    const plugin = makePlugin();
    openTab(plugin);

    const syncRow = findByName('Sync now');
    const syncBtn = buttonByLabel(syncRow!, 'Sync now');
    expect(syncBtn).toBeDefined();
    await syncBtn!.onClick();

    expect(plugin.triggerVaultSync).toHaveBeenCalledOnce();
  });

  it('subscribes to plugin status events and unsubscribes on hide()', () => {
    const plugin = makePlugin();
    const tab = openTab(plugin);

    expect(plugin.__lastStatusListener).toBeDefined();
    tab.hide();
    expect(plugin.__lastStatusListener).toBeUndefined();
  });

  it('cleans up the previous listener when display() is called again', () => {
    const plugin = makePlugin();
    const tab = openTab(plugin);
    const firstListener = plugin.__lastStatusListener;

    tab.display();
    const secondListener = plugin.__lastStatusListener;

    expect(firstListener).toBeDefined();
    expect(secondListener).toBeDefined();
    expect(secondListener).not.toBe(firstListener);
  });
});

// ── Developer mode toggle reveals advanced settings ──
describe('SilentStoneSyncSettingTab — Developer mode toggle', () => {
  it('reveals Server URL, Debug logging, Folder ID, and Test Syncthing connection when on', () => {
    const plugin = makePlugin({
      settings: { ...makePlugin().settings, developerMode: true },
    });
    openTab(plugin);

    expect(findByName('Server URL')).toBeDefined();
    expect(findByName('Debug logging')).toBeDefined();
    expect(findByName('Folder ID')).toBeDefined();
    expect(findByName('Test Syncthing connection')).toBeDefined();
  });

  it('persists the toggle change and re-renders', async () => {
    const plugin = makePlugin();
    openTab(plugin);

    const devRow = findByName('Developer mode');
    expect(devRow?.toggleOnChange).toBeDefined();

    // Flipping the toggle persists + re-renders. We assert saveSettings was hit and
    // the post-toggle setting reflects the new value.
    await devRow!.toggleOnChange!(true);
    expect(plugin.saveSettings).toHaveBeenCalledOnce();
    expect(plugin.settings.developerMode).toBe(true);
  });
});

// ── Conflict resolution dropdown ─────────────────
describe('SilentStoneSyncSettingTab — Conflict resolution', () => {
  it('persists the selection on change', async () => {
    const plugin = makePlugin();
    openTab(plugin);

    const row = findByName('On conflict');
    expect(row?.dropdownOnChange).toBeDefined();
    await row!.dropdownOnChange!('keep-local');

    expect(plugin.saveSettings).toHaveBeenCalledOnce();
    expect(plugin.settings.conflictStrategy).toBe('keep-local');
  });
});

// ── Pure helpers: formatRelativeTime + formatBytes ──
describe('formatRelativeTime', () => {
  it('returns "just now" for very recent timestamps', () => {
    expect(formatRelativeTime(new Date().toISOString())).toBe('just now');
  });

  it('returns seconds for timestamps within the last minute', () => {
    const ts = new Date(Date.now() - 30_000).toISOString();
    expect(formatRelativeTime(ts)).toMatch(/^\d+s ago$/);
  });

  it('returns minutes for timestamps within the last hour', () => {
    const ts = new Date(Date.now() - 5 * 60_000).toISOString();
    expect(formatRelativeTime(ts)).toMatch(/^\d+m ago$/);
  });

  it('returns hours for timestamps within the last day', () => {
    const ts = new Date(Date.now() - 3 * 3_600_000).toISOString();
    expect(formatRelativeTime(ts)).toMatch(/^\d+h ago$/);
  });

  it('returns days for older timestamps', () => {
    const ts = new Date(Date.now() - 5 * 86_400_000).toISOString();
    expect(formatRelativeTime(ts)).toMatch(/^\d+d ago$/);
  });

  it('returns "unknown" for invalid timestamps', () => {
    expect(formatRelativeTime('not-a-date')).toBe('unknown');
  });
});

describe('formatBytes', () => {
  it('formats sub-KB byte counts in B', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
  });

  it('formats KB / MB / GB with one or two decimals', () => {
    expect(formatBytes(2_048)).toBe('2.0 KB');
    expect(formatBytes(2_500_000)).toBe('2.4 MB');
    expect(formatBytes(2_500_000_000)).toBe('2.33 GB');
  });

  it('returns "—" for invalid byte counts', () => {
    expect(formatBytes(-1)).toBe('—');
    expect(formatBytes(NaN)).toBe('—');
  });
});
