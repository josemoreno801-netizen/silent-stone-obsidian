import { App, Modal, Setting } from 'obsidian';
import type SilentStoneSyncPlugin from '../main';

export class UnlockModal extends Modal {
  private plugin: SilentStoneSyncPlugin;
  private password = '';
  private submitting = false;
  private errorEl: HTMLElement | null = null;
  private submitBtn: HTMLButtonElement | null = null;
  private inputEl: HTMLInputElement | null = null;

  constructor(app: App, plugin: SilentStoneSyncPlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h2', { text: 'Unlock Silent Stone vault' });
    contentEl.createEl('p', {
      text: 'Enter your vault password. The master key stays in memory only — never written to disk.',
      cls: 'setting-item-description',
    });

    if (!this.plugin.settings.serverUrl || !this.plugin.settings.nickname) {
      contentEl.createEl('p', {
        text: 'Server URL and nickname must be set in Settings first.',
        cls: 'mod-warning',
      });
      return;
    }

    new Setting(contentEl)
      .setName('Password')
      .addText((text) => {
        text.setPlaceholder('vault password').onChange((v) => {
          this.password = v;
        });
        text.inputEl.type = 'password';
        text.inputEl.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void this.submit();
          }
        });
        this.inputEl = text.inputEl;
      });

    this.errorEl = contentEl.createEl('div', {
      cls: 'mod-warning',
      attr: { style: 'display:none;margin:0.5em 0;' },
    });

    new Setting(contentEl).addButton((btn) => {
      btn.setButtonText('Unlock').setCta();
      btn.onClick(() => void this.submit());
      this.submitBtn = btn.buttonEl;
    });

    queueMicrotask(() => this.inputEl?.focus());
  }

  onClose(): void {
    this.password = '';
    this.contentEl.empty();
  }

  private async submit(): Promise<void> {
    if (this.submitting) return;
    if (!this.password) {
      this.showError('Password required.');
      return;
    }

    this.submitting = true;
    this.hideError();
    if (this.submitBtn) {
      this.submitBtn.disabled = true;
      this.submitBtn.textContent = 'Unlocking…';
    }

    try {
      await this.plugin.unlockVaultWithPassword(this.password);
      this.close();
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      const friendly = this.friendlyError(raw);
      this.showError(friendly);
      if (this.inputEl) {
        this.inputEl.value = '';
        this.inputEl.focus();
      }
      this.password = '';
    } finally {
      this.submitting = false;
      if (this.submitBtn) {
        this.submitBtn.disabled = false;
        this.submitBtn.textContent = 'Unlock';
      }
    }
  }

  private friendlyError(raw: string): string {
    const lower = raw.toLowerCase();
    if (lower.includes('decrypt') || lower.includes('operation-specific')) {
      return 'Wrong password or corrupted vault keys.';
    }
    if (lower.includes('vault keys not set up')) {
      return raw;
    }
    if (lower.includes('server url') || lower.includes('nickname')) {
      return raw;
    }
    return `Unlock failed: ${raw}`;
  }

  private showError(msg: string): void {
    if (!this.errorEl) return;
    this.errorEl.setText(msg);
    this.errorEl.style.display = '';
  }

  private hideError(): void {
    if (!this.errorEl) return;
    this.errorEl.setText('');
    this.errorEl.style.display = 'none';
  }
}
