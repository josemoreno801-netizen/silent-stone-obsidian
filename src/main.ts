import { Notice, Plugin } from 'obsidian';
import {
  DEFAULT_SETTINGS,
  type SilentStoneSyncSettings,
  type SyncStatus,
  type SyncStatusEvent,
  type PersistedSyncMetrics,
} from './types';
import { SilentStoneSyncSettingTab } from './settings';
import { SilentStoneClient } from './api/client';
import { VaultClient } from './api/vault-client';
import {
  generateMasterKey,
  masterKeyToRecoveryPhrase,
  unwrapMasterKey,
  wrapMasterKey,
} from './crypto/keys';
import type { WrappedKey } from './crypto/types';
import { ManifestManager } from './sync/manifest';
import { FileWatcher } from './sync/watcher';
import { SyncEngine } from './sync/engine';
import { compileIgnorePrefixes, isIgnored } from './sync/ignore';
import { LoginModal } from './ui/login-modal';
import { LogoutModal } from './ui/logout-modal';
import { SetupModal } from './ui/setup-modal';
import { UnlockModal } from './ui/unlock-modal';

const KNOWN_SYNCED_KEY = 'vault.knownSynced';
const SYNC_METRICS_KEY = 'vault.syncMetrics';

export type PendingSetup = {
  vaultClient: VaultClient;
  masterKey: Uint8Array;
  wrapped: WrappedKey;
};

export default class SilentStoneSyncPlugin extends Plugin {
  settings: SilentStoneSyncSettings = DEFAULT_SETTINGS;
  client: SilentStoneClient | null = null;
  status: SyncStatus = 'not-configured';
  private statusBarEl: HTMLElement | null = null;

  // ── Vault sync (v0.3) ─────────────────────────────
  vaultClient: VaultClient | null = null;
  private vaultEngine: SyncEngine | null = null;
  private vaultKey: Uint8Array | null = null;

  // ── Trust-the-sync (v0.1.7) ───────────────────────
  /** Last-known metrics from a successful sync, restored on plugin reload. */
  lastSyncMetrics: PersistedSyncMetrics = {};
  /** Subscribers (e.g. settings panel) notified on every engine status transition. */
  private statusListeners: Set<(event: SyncStatusEvent) => void> = new Set();

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new SilentStoneSyncSettingTab(this.app, this));

    // Status bar
    this.statusBarEl = this.addStatusBarItem();
    this.updateStatusBar();

    // Commands
    this.addCommand({
      id: 'legacy-syncthing-sync-now',
      name: 'Legacy Syncthing: sync now',
      callback: () => this.triggerSync(),
    });

    this.addCommand({
      id: 'check-connection',
      name: 'Check server connection',
      callback: () => this.checkConnection(),
    });

    this.addCommand({
      id: 'vault-login',
      name: 'Vault: log in',
      callback: () => new LoginModal(this.app, this).open(),
    });

    this.addCommand({
      id: 'vault-unlock',
      name: 'Vault: unlock with password',
      callback: () => new UnlockModal(this.app, this).open(),
    });

    this.addCommand({
      id: 'vault-setup',
      name: 'Vault: first-time setup',
      callback: () => new SetupModal(this.app, this).open(),
    });

    this.addCommand({
      id: 'sync-now',
      name: 'Sync vault now',
      callback: () => this.triggerVaultSync(),
    });

    this.addCommand({
      id: 'vault-lock',
      name: 'Vault: lock (clear in-memory key)',
      callback: () => this.lockVault(),
    });

    this.addCommand({
      id: 'vault-logout',
      name: 'Vault: log out',
      callback: () => new LogoutModal(this.app, this).open(),
    });

    this.addCommand({
      id: 'open-dashboard',
      name: 'Open Silent Stone dashboard',
      callback: () => this.openDashboard(),
    });

    // Ribbon icon
    this.addRibbonIcon('cloud', 'Sync with Silent Stone', () => {
      this.triggerVaultSync();
    });

    // Initialize client if configured
    if (this.settings.serverUrl && this.settings.authToken) {
      this.client = new SilentStoneClient(this.settings.serverUrl, this.settings.authToken);
      this.status = 'idle';
      this.updateStatusBar();

      if (this.settings.syncOnStartup) {
        this.triggerSync();
      }
    }

    // Rehydrate vault client from persisted Bearer token (v0.3).
    // Master key is NOT persisted by design — plugin lands in a "connected
    // but locked" state on every reload. Rehydrating the client (without
    // a key) lets the Test button + status bar report accurate connectivity;
    // auto-popping the unlock modal gives the user a one-click path to
    // arming the runtime without hunting through the command palette.
    if (this.settings.serverUrl && this.settings.vaultAuthToken) {
      this.vaultClient = new VaultClient(
        this.settings.serverUrl,
        this.settings.vaultAuthToken,
      );
      this.app.workspace.onLayoutReady(() => {
        new UnlockModal(this.app, this).open();
      });
    } else if (!this.settings.vaultAuthToken) {
      // First-run UX: no Bearer token persisted → auto-popup login modal so
      // the user isn't left hunting through the command palette. Deferred via
      // setTimeout so the workspace finishes loading before the modal opens.
      this.app.workspace.onLayoutReady(() => {
        new LoginModal(this.app, this).open();
      });
    }

    // TODO: Register vault file watchers for auto-sync
    // TODO: Set up periodic sync interval
  }

  onunload(): void {
    // Obsidian handles cleanup of registered events/commands automatically
  }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) ?? {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
    // Restore last-known sync metrics so the settings panel can render the post-sync state
    // immediately on plugin reload (avoids a "no data" flash before the next sync runs).
    if (data[SYNC_METRICS_KEY] && typeof data[SYNC_METRICS_KEY] === 'object') {
      this.lastSyncMetrics = data[SYNC_METRICS_KEY] as PersistedSyncMetrics;
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);

    // Reinitialize client when settings change
    if (this.settings.serverUrl && this.settings.authToken) {
      this.client = new SilentStoneClient(this.settings.serverUrl, this.settings.authToken);
    }
  }

  /**
   * Persist `this.lastSyncMetrics` alongside settings + knownSynced. Reads existing
   * stored data first to avoid clobbering sibling keys.
   */
  private async persistSyncMetrics(): Promise<void> {
    const data = (await this.loadData()) ?? {};
    data[SYNC_METRICS_KEY] = this.lastSyncMetrics;
    await this.saveData(data);
  }

  /** Subscribe to live status events from the sync engine. Returns an unsubscribe handle. */
  addStatusListener(listener: (event: SyncStatusEvent) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  /**
   * Open the Silent Stone web dashboard in the user's browser, scoped to whichever
   * server URL the plugin is connected to. Falls back to the canonical prod host
   * when settings are empty so the button never silently no-ops.
   */
  openDashboard(): void {
    const host = this.settings.serverUrl?.replace(/\/+$/, '') || 'https://silentstone.one';
    window.open(`${host}/member`, '_blank');
  }

  private updateStatusBar(): void {
    if (!this.statusBarEl) return;

    const labels: Record<SyncStatus, string> = {
      'idle': 'SS: Synced',
      'syncing': 'SS: Syncing...',
      'error': 'SS: Error',
      'offline': 'SS: Offline',
      'not-configured': 'SS: Not connected',
    };

    this.statusBarEl.setText(labels[this.status]);
  }

  async triggerSync(): Promise<void> {
    if (!this.client) {
      new Notice('Silent Stone not configured. Open settings to connect.');
      return;
    }

    if (!this.settings.folderId) {
      new Notice('No folder selected. Set a folder ID in settings.');
      return;
    }

    this.status = 'syncing';
    this.updateStatusBar();

    try {
      // TODO: Implement actual sync logic
      // 1. List server files
      // 2. Compare with local vault state
      // 3. Upload local changes
      // 4. Download server changes
      // 5. Handle conflicts

      const folders = await this.client.listFolders();
      const folder = folders.find((f) => f.id === this.settings.folderId);

      if (!folder) {
        new Notice(`Folder "${this.settings.folderId}" not found on server.`);
        this.status = 'error';
        this.updateStatusBar();
        return;
      }

      new Notice(`Connected to folder "${folder.label}". Full sync not yet implemented.`);
      this.status = 'idle';
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      new Notice(`Sync failed: ${msg}`);
      this.status = 'error';
    }

    this.updateStatusBar();
  }

  /**
   * Unlock the vault sync path by deriving the master key from the user's password.
   *
   * Exposed as a public method so users can invoke it from Obsidian's dev console
   * during v0.3 before the unlock modal UI ships:
   *     app.plugins.plugins['silent-stone-sync'].unlockVaultWithPassword('your-password')
   *
   * On success: creates a fresh VaultClient, unwraps the master key, instantiates
   * the sync engine, and starts the file watcher. The key lives in memory only —
   * never persisted.
   */
  async unlockVaultWithPassword(password: string): Promise<void> {
    if (!this.settings.serverUrl || !this.settings.nickname) {
      throw new Error('Server URL and nickname must be configured in settings first.');
    }

    const bootstrap = new VaultClient(this.settings.serverUrl, '');
    const tokenResp = await bootstrap.createToken({
      nickname: this.settings.nickname,
      password,
      label: `obsidian-${this.manifest.id}`,
    });

    this.settings.vaultAuthToken = tokenResp.token;
    await this.saveSettings();

    const vaultClient = new VaultClient(this.settings.serverUrl, tokenResp.token);
    const keyParams = await vaultClient.getKeys();
    if (!keyParams) {
      throw new Error('Vault keys not set up on server. Run first-time setup.');
    }

    const masterKey = await unwrapMasterKey({
      password,
      encryptedMasterKey: keyParams.encryptedMasterKey,
      salt: keyParams.salt,
      argon2Params: {
        memory: keyParams.argon2Memory,
        time: keyParams.argon2Time,
        parallelism: keyParams.argon2Parallelism,
      },
    });

    await this.armVaultRuntime(vaultClient, masterKey);
    new Notice('Vault unlocked.');
  }

  /**
   * Generate a fresh master key + recovery phrase and wrap the key with the
   * user's password. No network writes happen here — the caller must show the
   * recovery phrase, get confirmation, then call {@link commitVaultSetup}.
   *
   * Also mints a fresh Bearer token (public endpoint) and verifies no keys
   * exist server-side yet — if they do, fails fast with a friendly message.
   */
  async generateVaultMaterial(password: string): Promise<{
    recoveryPhrase: string;
    pendingSetup: PendingSetup;
  }> {
    if (!this.settings.serverUrl || !this.settings.nickname) {
      throw new Error('Server URL and nickname must be configured in settings first.');
    }

    const bootstrap = new VaultClient(this.settings.serverUrl, '');
    const tokenResp = await bootstrap.createToken({
      nickname: this.settings.nickname,
      password,
      label: `obsidian-${this.manifest.id}-setup`,
    });

    const vaultClient = new VaultClient(this.settings.serverUrl, tokenResp.token);
    const existing = await vaultClient.getKeys();
    if (existing !== null) {
      throw new Error('Vault already initialized for this nickname. Use Unlock instead.');
    }

    const material = generateMasterKey();
    const phrase = masterKeyToRecoveryPhrase(material).mnemonic;
    const wrapped = await wrapMasterKey(material.key, password);

    return {
      recoveryPhrase: phrase,
      pendingSetup: {
        vaultClient,
        masterKey: material.key,
        wrapped,
      },
    };
  }

  /**
   * Register the wrapped master key on the server and arm the runtime so the
   * vault is immediately usable. Called after the user confirms they saved
   * the recovery phrase.
   */
  async commitVaultSetup(pending: PendingSetup): Promise<void> {
    await pending.vaultClient.setupKeys({
      encryptedMasterKey: pending.wrapped.encryptedMasterKey,
      salt: pending.wrapped.salt,
      argon2Memory: pending.wrapped.argon2Params.memory,
      argon2Time: pending.wrapped.argon2Params.time,
      argon2Parallelism: pending.wrapped.argon2Params.parallelism,
    });
    // Persist the Bearer token so the plugin recognizes the vault as
    // connected on the next reload. Without this, the setup wizard
    // succeeds server-side but the plugin forgets the token the moment
    // Obsidian restarts, and the Test button reports "not connected".
    this.settings.vaultAuthToken = pending.vaultClient.bearerToken;
    await this.saveSettings();
    await this.armVaultRuntime(pending.vaultClient, pending.masterKey);
    new Notice('Vault created. Keep your recovery phrase safe.');
  }

  /**
   * Construct the manifest manager, file watcher, and sync engine around a
   * ready-to-use VaultClient + master key, then transition the plugin into
   * the unlocked state. Shared by the unlock and first-time-setup flows.
   */
  private async armVaultRuntime(
    vaultClient: VaultClient,
    masterKey: Uint8Array,
  ): Promise<void> {
    const manifest = new ManifestManager(vaultClient, masterKey);
    const watcher = new FileWatcher(this, this.app.vault, {
      ignorePaths: this.settings.ignorePaths,
    });
    watcher.start();

    const ignorePrefixes = compileIgnorePrefixes(this.settings.ignorePaths);

    const persisted = (await this.loadData()) ?? {};
    const knownSynced = new Set<string>(persisted[KNOWN_SYNCED_KEY] ?? []);

    const engine = new SyncEngine({
      client: vaultClient,
      manifest,
      watcher,
      vault: {
        readBinary: (path) => this.app.vault.adapter.readBinary(path),
        exists: (path) => this.app.vault.adapter.exists(path),
        create: async (path, data) => {
          await this.app.vault.adapter.writeBinary(path, data);
        },
        modify: async (path, data) => {
          await this.app.vault.adapter.writeBinary(path, data);
        },
        delete: async (path) => {
          await this.app.vault.adapter.remove(path);
        },
        listAll: async () =>
          this.app.vault
            .getFiles()
            .map((f) => f.path)
            .filter((p) => !isIgnored(p, ignorePrefixes)),
      },
      masterKey,
      knownSynced,
      onStatusChange: (event) => {
        this.status =
          event.state === 'idle' ? 'idle' : event.state === 'syncing' ? 'syncing' : 'error';

        // Capture metrics on the canonical "sync complete" event (only sync() emits with metrics).
        // Error events update the message so the settings panel can surface the latest reason.
        if (event.state === 'idle' && event.fileCount !== undefined) {
          this.lastSyncMetrics = {
            lastSyncAt: event.lastSyncAt,
            fileCount: event.fileCount,
            errorMessage: undefined,
          };
          void this.persistSyncMetrics();
        } else if (event.state === 'error' && event.errorMessage) {
          this.lastSyncMetrics = { ...this.lastSyncMetrics, errorMessage: event.errorMessage };
          void this.persistSyncMetrics();
        }

        for (const listener of this.statusListeners) listener(event);
        this.updateStatusBar();
      },
      onStateUpdate: async (ks) => {
        const data = (await this.loadData()) ?? {};
        data[KNOWN_SYNCED_KEY] = [...ks];
        await this.saveData(data);
      },
    });

    this.vaultClient = vaultClient;
    this.vaultEngine = engine;
    this.vaultKey = masterKey;
    this.status = 'idle';
    this.updateStatusBar();
  }

  lockVault(): void {
    if (this.vaultKey) this.vaultKey.fill(0);
    this.vaultClient = null;
    this.vaultEngine = null;
    this.vaultKey = null;
    this.status = 'not-configured';
    this.updateStatusBar();
    new Notice('Vault locked.');
  }

  /**
   * Full session exit. Clears the persisted Bearer token so the next plugin reload
   * routes through LoginModal (a true re-login that mints a fresh token), not
   * UnlockModal (which assumes the token is still valid).
   *
   * Server-side revocation is not available on the Vault track — tokens are
   * stateless 90-day Bearers that expire naturally.
   *
   * Preserves KNOWN_SYNCED_KEY: that's a safety guard against destructive
   * re-sync, and clearing it belongs to "Switch vault" (issue #9), not logout.
   */
  async logoutVault(): Promise<void> {
    // In-memory teardown — mirrors lockVault, but no Notice (we show our own).
    if (this.vaultKey) this.vaultKey.fill(0);
    this.vaultClient = null;
    this.vaultEngine = null;
    this.vaultKey = null;
    this.status = 'not-configured';
    this.updateStatusBar();

    // Persisted teardown. saveData is a full overwrite (see persistSyncMetrics),
    // so we read-merge-write to preserve KNOWN_SYNCED_KEY.
    this.settings.vaultAuthToken = '';
    this.settings.nickname = '';
    this.lastSyncMetrics = {};

    const data = (await this.loadData()) ?? {};
    Object.assign(data, this.settings);
    delete data[SYNC_METRICS_KEY];
    await this.saveData(data);

    new Notice('Logged out. Use "Vault: log in" to reconnect.');
  }

  async triggerVaultSync(): Promise<void> {
    if (!this.vaultEngine) {
      new Notice('Vault locked. Run "Vault: unlock with password" from the command palette.');
      return;
    }
    try {
      await this.vaultEngine.sync();
      new Notice('Vault synced.');
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      new Notice(`Vault sync failed: ${msg}`);
    }
  }

  private async checkConnection(): Promise<void> {
    if (!this.client) {
      new Notice('Not configured. Open settings first.');
      return;
    }

    try {
      const user = await this.client.me();
      new Notice(`Connected as ${user.nickname} (${user.role})`);
      this.status = 'idle';
    } catch {
      new Notice('Connection failed. Check settings.');
      this.status = 'offline';
    }

    this.updateStatusBar();
  }

  /**
   * Probe the vault server for the current stored Bearer token.
   *
   * Used by the settings "Test connection" button so users get truthful
   * feedback after first-time setup instead of the generic "enter
   * credentials" message. Never mutates state — pure read probe.
   *
   * Returns:
   * - `{ kind: 'not-configured' }` if no vault token is persisted (wizard never completed).
   * - `{ kind: 'connected', usedBytes, tier }` when the token round-trips through `/api/vault/status`.
   * - `{ kind: 'unauthorized' }` if the server rejects the token (expired or revoked).
   * - `{ kind: 'error', message }` on any other failure.
   */
  async checkVaultConnection(): Promise<
    | { kind: 'not-configured' }
    | { kind: 'connected'; usedBytes: number; tier: string }
    | { kind: 'unauthorized' }
    | { kind: 'error'; message: string }
    > {
    if (!this.vaultClient) return { kind: 'not-configured' };
    try {
      const status = await this.vaultClient.getStatus();
      return { kind: 'connected', usedBytes: status.storageUsedBytes, tier: status.tier };
    } catch (e: unknown) {
      if (e && typeof e === 'object' && 'status' in e && (e as { status: number }).status === 401) {
        return { kind: 'unauthorized' };
      }
      const message = e instanceof Error ? e.message : 'Unknown error';
      return { kind: 'error', message };
    }
  }
}
