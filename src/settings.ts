import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type SilentStoneSyncPlugin from './main';
import { SilentStoneClient } from './api/client';
import { LogoutModal } from './ui/logout-modal';

/**
 * Settings tab for the Silent Stone Sync plugin.
 *
 * Section order is intentional:
 *   1. Account     — who you are (read-only nickname, Open Dashboard, Lock).
 *   2. Vault       — live sync status panel + manual Sync Now button.
 *   3. Sync        — automation toggles (auto-sync, interval, on-startup).
 *   4. Conflict    — conflict resolution strategy dropdown.
 *   5. Developer   — collapsed by default; reveals server URL, debug logging,
 *                    and the legacy Syncthing fields (Folder ID, Test connection).
 *
 * The vault status panel re-renders live on every engine status transition by
 * subscribing to the plugin's status listener registry. The subscription is
 * cleaned up on hide() or on the next display() call.
 */
export class SilentStoneSyncSettingTab extends PluginSettingTab {
  plugin: SilentStoneSyncPlugin;
  private unsubscribeStatus: (() => void) | null = null;
  private statusPanelEl: HTMLElement | null = null;

  constructor(app: App, plugin: SilentStoneSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    // Clean up any previous subscription before re-rendering — display() is
    // called multiple times (e.g. when the developer-mode toggle re-renders).
    this.cleanupStatusListener();

    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Silent Stone Sync' });

    this.renderAccountSection(containerEl);
    this.renderVaultSection(containerEl);
    this.renderSyncSection(containerEl);
    this.renderConflictSection(containerEl);
    this.renderDeveloperToggle(containerEl);
    if (this.plugin.settings.developerMode) {
      this.renderDeveloperSection(containerEl);
    }

    // Subscribe to live status updates so the Vault section panel stays current
    // while the user has the settings tab open during a sync.
    this.unsubscribeStatus = this.plugin.addStatusListener(() => {
      if (this.statusPanelEl) this.renderStatusPanel(this.statusPanelEl);
    });
  }

  hide(): void {
    this.cleanupStatusListener();
    super.hide();
  }

  private cleanupStatusListener(): void {
    if (this.unsubscribeStatus) {
      this.unsubscribeStatus();
      this.unsubscribeStatus = null;
    }
  }

  // ── Section: Account ─────────────────────────────────────────────────────
  private renderAccountSection(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: 'Account' });

    new Setting(containerEl)
      .setName('Nickname')
      .setDesc(
        this.plugin.settings.nickname
          ? this.plugin.settings.nickname
          : 'Not signed in. Run "Vault: log in" from the command palette.',
      )
      .addButton((btn) =>
        btn
          .setButtonText('Open dashboard')
          .setTooltip('View your vault on the web (silentstone.one)')
          .onClick(() => this.plugin.openDashboard()),
      )
      .addButton((btn) =>
        btn
          .setButtonText('Lock vault')
          .setWarning()
          .setTooltip('Clear the in-memory key. Re-unlock with your password to resume sync.')
          .onClick(() => this.plugin.lockVault()),
      )
      .addButton((btn) =>
        btn
          .setButtonText('Log out')
          .setWarning()
          .setTooltip(
            "Sign out and clear your saved connection. You'll need your password and nickname to reconnect.",
          )
          .onClick(() =>
            new LogoutModal(this.plugin.app, this.plugin, () => this.display()).open(),
          ),
      );
  }

  // ── Section: Vault (status panel + Sync Now) ─────────────────────────────
  private renderVaultSection(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: 'Vault' });

    this.statusPanelEl = containerEl.createDiv({ cls: 'silent-stone-status-panel' });
    this.renderStatusPanel(this.statusPanelEl);

    new Setting(containerEl)
      .setName('Sync now')
      .setDesc('Manually trigger a vault sync against the server.')
      .addButton((btn) =>
        btn
          .setButtonText('Sync now')
          .setCta()
          .onClick(() => this.plugin.triggerVaultSync()),
      );
  }

  /**
   * Render the live status block: state badge, last-sync relative time, file count,
   * any current error message, and an async-loaded storage bar.
   *
   * Called on initial display AND on every engine status transition (via listener).
   * Built with createDiv/setText only — never innerHTML — to satisfy the security
   * hook in CLAUDE.md and the obsidian plugin lint rules.
   */
  private renderStatusPanel(el: HTMLElement): void {
    el.empty();

    const status = this.plugin.status;
    const metrics = this.plugin.lastSyncMetrics;

    const stateLabel: Record<typeof status, string> = {
      idle: 'Synced',
      syncing: 'Syncing…',
      error: 'Error',
      offline: 'Offline',
      'not-configured': 'Not connected',
    };
    const stateLine = el.createDiv({ cls: 'silent-stone-status-line' });
    stateLine.createSpan({ text: 'Status: ', cls: 'silent-stone-status-label' });
    stateLine.createSpan({
      text: stateLabel[status],
      cls: `silent-stone-status-badge silent-stone-status-${status}`,
    });

    const lastSyncLine = el.createDiv({ cls: 'silent-stone-status-line' });
    lastSyncLine.createSpan({ text: 'Last sync: ', cls: 'silent-stone-status-label' });
    lastSyncLine.createSpan({
      text: metrics.lastSyncAt ? formatRelativeTime(metrics.lastSyncAt) : 'never',
    });

    const fileCountLine = el.createDiv({ cls: 'silent-stone-status-line' });
    fileCountLine.createSpan({ text: 'Files: ', cls: 'silent-stone-status-label' });
    fileCountLine.createSpan({
      text:
        metrics.fileCount !== undefined
          ? `${metrics.fileCount} synced`
          : '—',
    });

    if (metrics.errorMessage) {
      const errLine = el.createDiv({ cls: 'silent-stone-status-line silent-stone-status-error' });
      errLine.createSpan({ text: 'Last error: ', cls: 'silent-stone-status-label' });
      errLine.createSpan({ text: metrics.errorMessage });
    }

    // Storage bar — only when the vault client is available. Async fetch so
    // the rest of the panel renders instantly; the storage line populates when
    // the network call returns (or shows "unavailable" on failure).
    if (this.plugin.vaultClient) {
      const storageLine = el.createDiv({ cls: 'silent-stone-status-line' });
      storageLine.createSpan({ text: 'Storage: ', cls: 'silent-stone-status-label' });
      const valueSpan = storageLine.createSpan({ text: 'loading…' });

      this.plugin.vaultClient.getStatus().then(
        (s) => {
          const used = formatBytes(s.storageUsedBytes);
          const limit = formatBytes(s.storageLimitBytes);
          const pct =
            s.storageLimitBytes > 0
              ? Math.round((s.storageUsedBytes / s.storageLimitBytes) * 100)
              : 0;
          valueSpan.setText(`${used} / ${limit} (${pct}%) — ${s.tier}`);
        },
        () => valueSpan.setText('unavailable'),
      );
    }
  }

  // ── Section: Sync ────────────────────────────────────────────────────────
  private renderSyncSection(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: 'Sync' });

    new Setting(containerEl)
      .setName('Auto-sync')
      .setDesc('Automatically sync on file changes.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoSync).onChange(async (value) => {
          this.plugin.settings.autoSync = value;
          await this.plugin.saveSettings();
          this.plugin.setAutoSyncEnabled(value);
        }),
      );

    new Setting(containerEl)
      .setName('Sync interval')
      .setDesc('Minutes between automatic server checks.')
      .addSlider((slider) =>
        slider
          .setLimits(1, 60, 1)
          .setValue(this.plugin.settings.syncInterval)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.syncInterval = value;
            await this.plugin.saveSettings();
            this.plugin.setPeriodicSyncInterval(value);
          }),
      );

    new Setting(containerEl)
      .setName('Sync on startup')
      .setDesc('Sync immediately when the plugin loads.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.syncOnStartup).onChange(async (value) => {
          this.plugin.settings.syncOnStartup = value;
          await this.plugin.saveSettings();
        }),
      );
  }

  // ── Section: Conflict resolution ─────────────────────────────────────────
  private renderConflictSection(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: 'Conflict resolution' });

    new Setting(containerEl)
      .setName('On conflict')
      .setDesc('What to do when a local file disagrees with the server version.')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('ask', 'Ask each time')
          .addOption('keep-local', 'Always keep local')
          .addOption('keep-server', 'Always keep server')
          .addOption('keep-both', 'Keep both versions')
          .setValue(this.plugin.settings.conflictStrategy)
          .onChange(async (value) => {
            this.plugin.settings.conflictStrategy = value as
              | 'ask'
              | 'keep-local'
              | 'keep-server'
              | 'keep-both';
            await this.plugin.saveSettings();
          }),
      );
  }

  // ── Section: Developer mode toggle (always rendered) ─────────────────────
  private renderDeveloperToggle(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName('Developer mode')
      .setDesc(
        'Reveal advanced settings: server URL, debug logging, and the legacy Syncthing fields.',
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.developerMode).onChange(async (value) => {
          this.plugin.settings.developerMode = value;
          await this.plugin.saveSettings();
          // Re-render to show or hide the developer section. cleanupStatusListener()
          // at the top of display() handles the listener leak.
          this.display();
        }),
      );
  }

  // ── Section: Developer (collapsed by default) ────────────────────────────
  private renderDeveloperSection(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: 'Developer mode' });

    new Setting(containerEl)
      .setName('Server URL')
      .setDesc('Override the Silent Stone server. Leave blank to use silentstone.one.')
      .addText((text) =>
        text
          .setPlaceholder('https://silentstone.one')
          .setValue(this.plugin.settings.serverUrl)
          .onChange(async (value) => {
            this.plugin.settings.serverUrl = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Debug logging')
      .setDesc('Log detailed sync operations to the console.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.debugLogging).onChange(async (value) => {
          this.plugin.settings.debugLogging = value;
          await this.plugin.saveSettings();
        }),
      );

    containerEl.createEl('h4', { text: 'Legacy Syncthing' });
    containerEl.createEl('p', {
      text: 'These fields control the deprecated Syncthing track. Most users can ignore them.',
      cls: 'setting-item-description',
    });

    new Setting(containerEl)
      .setName('Folder ID')
      .setDesc('The Syncthing folder ID this vault syncs with.')
      .addText((text) =>
        text
          .setPlaceholder('my-vault')
          .setValue(this.plugin.settings.folderId)
          .onChange(async (value) => {
            this.plugin.settings.folderId = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Test Syncthing connection')
      .setDesc('Probe the legacy Syncthing API for the configured nickname.')
      .addButton((btn) =>
        btn.setButtonText('Test').onClick(async () => {
          const client = new SilentStoneClient(
            this.plugin.settings.serverUrl,
            this.plugin.settings.authToken,
          );

          const healthy = await client.health();
          if (!healthy) {
            new Notice('Cannot reach server. Check the URL.');
            return;
          }

          if (!this.plugin.settings.authToken) {
            new Notice('No Syncthing auth token. Vault sync uses a separate Bearer token — try Vault: log in.');
            return;
          }

          try {
            const user = await client.me();
            new Notice(`Syncthing API connected as ${user.nickname} (${user.role}).`);
          } catch {
            new Notice('Server reachable but Syncthing token invalid.');
          }
        }),
      );
  }
}

/**
 * Format an ISO timestamp as a human-readable relative time. Coarse-grained on
 * purpose — the trust-the-sync UX cares about "just now / a few minutes / a few
 * hours / today / yesterday / N days", not exact seconds.
 */
export function formatRelativeTime(iso: string): string {
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return 'unknown';
  const ms = Date.now() - ts;
  if (ms < 0) return 'just now';
  if (ms < 5_000) return 'just now';
  if (ms < 60_000) return `${Math.floor(ms / 1_000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

/**
 * Format a byte count with the largest sensible unit (B / KB / MB / GB).
 * Used for the storage bar in the Vault section.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
}
