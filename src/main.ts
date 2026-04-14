import { Notice, Plugin } from 'obsidian';
import { DEFAULT_SETTINGS, type SilentStoneSyncSettings, type SyncStatus } from './types';
import { SilentStoneSyncSettingTab } from './settings';
import { SilentStoneClient } from './api/client';
import { VaultClient } from './api/vault-client';
import { unwrapMasterKey } from './crypto/keys';
import { ManifestManager } from './sync/manifest';
import { FileWatcher } from './sync/watcher';
import { SyncEngine } from './sync/engine';

const KNOWN_SYNCED_KEY = 'vault.knownSynced';

export default class SilentStoneSyncPlugin extends Plugin {
  settings: SilentStoneSyncSettings = DEFAULT_SETTINGS;
  client: SilentStoneClient | null = null;
  status: SyncStatus = 'not-configured';
  private statusBarEl: HTMLElement | null = null;

  // ── Vault sync (v0.3) ─────────────────────────────
  private vaultClient: VaultClient | null = null;
  private vaultEngine: SyncEngine | null = null;
  private vaultKey: Uint8Array | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new SilentStoneSyncSettingTab(this.app, this));

    // Status bar
    this.statusBarEl = this.addStatusBarItem();
    this.updateStatusBar();

    // Commands
    this.addCommand({
      id: 'sync-now',
      name: 'Sync vault now',
      callback: () => this.triggerSync(),
    });

    this.addCommand({
      id: 'check-connection',
      name: 'Check server connection',
      callback: () => this.checkConnection(),
    });

    this.addCommand({
      id: 'vault-sync-now',
      name: 'Vault: sync now (E2E encrypted)',
      callback: () => this.triggerVaultSync(),
    });

    this.addCommand({
      id: 'vault-lock',
      name: 'Vault: lock (clear in-memory key)',
      callback: () => this.lockVault(),
    });

    // Ribbon icon
    this.addRibbonIcon('cloud', 'Sync with Silent Stone', () => {
      this.triggerSync();
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

    // TODO: Register vault file watchers for auto-sync
    // TODO: Set up periodic sync interval
  }

  onunload(): void {
    // Obsidian handles cleanup of registered events/commands automatically
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);

    // Reinitialize client when settings change
    if (this.settings.serverUrl && this.settings.authToken) {
      this.client = new SilentStoneClient(this.settings.serverUrl, this.settings.authToken);
    }
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

    const manifest = new ManifestManager(vaultClient, masterKey);
    const watcher = new FileWatcher(this, this.app.vault, {
      ignorePaths: this.settings.ignorePaths,
    });
    watcher.start();

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
      },
      masterKey,
      knownSynced,
      onStatusChange: (s) => {
        this.status = s === 'idle' ? 'idle' : s === 'syncing' ? 'syncing' : 'error';
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
    new Notice('Vault unlocked.');
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

  async triggerVaultSync(): Promise<void> {
    if (!this.vaultEngine) {
      new Notice(
        'Vault locked. Run `unlockVaultWithPassword(password)` from the dev console (Ctrl+Shift+I).',
      );
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
}
