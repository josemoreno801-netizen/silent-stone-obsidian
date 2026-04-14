import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type SilentStoneSyncPlugin from './main';
import { SilentStoneClient } from './api/client';

export class SilentStoneSyncSettingTab extends PluginSettingTab {
  plugin: SilentStoneSyncPlugin;

  constructor(app: App, plugin: SilentStoneSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Silent Stone Sync' });

    // --- Connection ---
    containerEl.createEl('h3', { text: 'Connection' });

    new Setting(containerEl)
      .setName('Server URL')
      .setDesc('Your Silent Stone server address')
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
      .setName('Nickname')
      .setDesc('Your Silent Stone username')
      .addText((text) =>
        text
          .setPlaceholder('admin')
          .setValue(this.plugin.settings.nickname)
          .onChange(async (value) => {
            this.plugin.settings.nickname = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Test connection')
      .setDesc('Verify server is reachable and credentials are valid')
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

          const vaultResult = await this.plugin.checkVaultConnection();
          if (vaultResult.kind === 'connected') {
            const mb = (vaultResult.usedBytes / (1024 * 1024)).toFixed(1);
            new Notice(
              `Vault connected (tier: ${vaultResult.tier}, ${mb} MB used).`,
            );
            return;
          }
          if (vaultResult.kind === 'unauthorized') {
            new Notice(
              'Vault token expired or revoked. Run "Vault: unlock with password" to refresh.',
            );
            return;
          }
          if (vaultResult.kind === 'error') {
            new Notice(`Vault check failed: ${vaultResult.message}`);
            return;
          }

          // vaultResult.kind === 'not-configured' — fall through to Syncthing check.
          if (this.plugin.settings.authToken) {
            try {
              const user = await client.me();
              new Notice(`Connected as ${user.nickname} (${user.role})`);
            } catch {
              new Notice('Server reachable but token is invalid. Please log in again.');
            }
          } else {
            new Notice(
              'Server reachable. Run "Vault: first-time setup" or "Vault: unlock with password" from the command palette.',
            );
          }
        }),
      );

    // --- Sync ---
    containerEl.createEl('h3', { text: 'Sync' });

    new Setting(containerEl)
      .setName('Folder ID')
      .setDesc('The Silent Stone folder to sync this vault with')
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
      .setName('Auto-sync')
      .setDesc('Automatically sync on file changes')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoSync).onChange(async (value) => {
          this.plugin.settings.autoSync = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Sync interval')
      .setDesc('Minutes between automatic server checks')
      .addSlider((slider) =>
        slider
          .setLimits(1, 60, 1)
          .setValue(this.plugin.settings.syncInterval)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.syncInterval = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Sync on startup')
      .setDesc('Sync immediately when the plugin loads')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.syncOnStartup).onChange(async (value) => {
          this.plugin.settings.syncOnStartup = value;
          await this.plugin.saveSettings();
        }),
      );

    // --- Advanced ---
    containerEl.createEl('h3', { text: 'Advanced' });

    new Setting(containerEl)
      .setName('Conflict resolution')
      .setDesc('What to do when local and server files conflict')
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

    new Setting(containerEl)
      .setName('Debug logging')
      .setDesc('Log detailed sync operations to console')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.debugLogging).onChange(async (value) => {
          this.plugin.settings.debugLogging = value;
          await this.plugin.saveSettings();
        }),
      );
  }
}
