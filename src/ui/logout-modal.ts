import { App, Modal, Setting } from 'obsidian';
import type SilentStoneSyncPlugin from '../main';

export class LogoutModal extends Modal {
  private plugin: SilentStoneSyncPlugin;
  private submitting = false;
  private confirmBtn: HTMLButtonElement | null = null;

  constructor(app: App, plugin: SilentStoneSyncPlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h2', { text: 'Log out of Silent Stone' });
    contentEl.createEl('p', {
      text:
        "This clears your saved connection token. You'll need your nickname and password to reconnect.",
      cls: 'setting-item-description',
    });
    contentEl.createEl('p', {
      text: 'Your local notes are not affected — only the connection to the server is cleared.',
      cls: 'setting-item-description',
    });

    new Setting(contentEl)
      .addButton((btn) => btn.setButtonText('Cancel').onClick(() => this.close()))
      .addButton((btn) => {
        btn
          .setButtonText('Log out')
          .setWarning()
          .onClick(() => void this.submit());
        this.confirmBtn = btn.buttonEl;
      });
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async submit(): Promise<void> {
    if (this.submitting) return;
    this.submitting = true;
    if (this.confirmBtn) {
      this.confirmBtn.disabled = true;
      this.confirmBtn.textContent = 'Logging out…';
    }
    try {
      await this.plugin.logoutVault();
      this.close();
    } finally {
      this.submitting = false;
      if (this.confirmBtn) {
        this.confirmBtn.disabled = false;
        this.confirmBtn.textContent = 'Log out';
      }
    }
  }
}
