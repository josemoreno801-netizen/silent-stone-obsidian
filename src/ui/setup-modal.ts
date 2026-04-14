import { App, Modal, Setting } from 'obsidian';
import type SilentStoneSyncPlugin from '../main';
import type { PendingSetup } from '../main';

export class SetupModal extends Modal {
  private plugin: SilentStoneSyncPlugin;
  private step: 1 | 2 | 3 = 1;
  private password = '';
  private confirmPassword = '';
  private pendingSetup: PendingSetup | null = null;
  private recoveryPhrase: string | null = null;
  private savedConfirmed = false;
  private timeoutId: number | null = null;
  private submitting = false;
  private errorEl: HTMLElement | null = null;
  private primaryBtn: HTMLButtonElement | null = null;
  private firstInputEl: HTMLInputElement | null = null;

  constructor(app: App, plugin: SilentStoneSyncPlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen(): void {
    this.renderStep();
  }

  onClose(): void {
    this.password = '';
    this.confirmPassword = '';
    this.pendingSetup = null;
    this.recoveryPhrase = null;
    if (this.timeoutId !== null) {
      window.clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    this.contentEl.empty();
  }

  private renderStep(): void {
    this.contentEl.empty();
    this.errorEl = null;
    this.primaryBtn = null;
    this.firstInputEl = null;

    if (this.step === 1) {
      this.renderStep1();
    } else if (this.step === 2) {
      this.renderStep2();
    } else {
      this.renderStep3();
    }
  }

  private renderStep1(): void {
    const { contentEl } = this;

    contentEl.createEl('h2', { text: 'Create your Silent Stone vault' });
    contentEl.createEl('p', {
      text: 'This password encrypts the master key on your device. Lose it and the recovery phrase is the only way back. The server never sees it.',
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
        text.setPlaceholder('at least 12 characters').onChange((v) => {
          this.password = v;
        });
        text.setValue(this.password);
        text.inputEl.type = 'password';
        text.inputEl.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void this.submitStep1();
          }
        });
        this.firstInputEl = text.inputEl;
      });

    new Setting(contentEl)
      .setName('Confirm password')
      .addText((text) => {
        text.setPlaceholder('re-enter password').onChange((v) => {
          this.confirmPassword = v;
        });
        text.setValue(this.confirmPassword);
        text.inputEl.type = 'password';
        text.inputEl.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void this.submitStep1();
          }
        });
      });

    this.errorEl = contentEl.createEl('div', {
      cls: 'mod-warning',
      attr: { style: 'display:none;margin:0.5em 0;' },
    });

    new Setting(contentEl).addButton((btn) => {
      btn.setButtonText('Continue').setCta();
      btn.onClick(() => void this.submitStep1());
      this.primaryBtn = btn.buttonEl;
    });

    queueMicrotask(() => this.firstInputEl?.focus());
  }

  private renderStep2(): void {
    const { contentEl } = this;

    contentEl.createEl('h2', { text: 'Save your recovery phrase' });

    const warning = contentEl.createEl('div', { cls: 'mod-warning' });
    warning.setText(
      'This 12-word phrase is the ONLY way to recover your vault if you forget your password. Silent Stone cannot recover it for you. Write it down NOW and store it somewhere safe.',
    );
    warning.style.margin = '0.5em 0';
    warning.style.padding = '0.75em';

    const phrase = this.recoveryPhrase ?? '';
    const words = phrase.split(/\s+/).filter((w) => w.length > 0);

    const grid = contentEl.createEl('div');
    grid.style.display = 'grid';
    grid.style.gridTemplateColumns = 'repeat(3,1fr)';
    grid.style.gap = '0.5em';
    grid.style.margin = '1em 0';

    words.forEach((word, i) => {
      const cell = grid.createEl('div');
      cell.style.fontFamily = 'var(--font-monospace, monospace)';
      cell.style.padding = '0.4em 0.6em';
      cell.style.border = '1px solid var(--background-modifier-border)';
      cell.style.borderRadius = '4px';
      cell.style.userSelect = 'text';
      cell.setText(`${i + 1}. ${word}`);
    });

    new Setting(contentEl).addButton((btn) => {
      btn.setButtonText('Copy to clipboard');
      btn.onClick(async () => {
        try {
          await navigator.clipboard.writeText(phrase);
          const original = btn.buttonEl.textContent ?? 'Copy to clipboard';
          btn.setButtonText('Copied');
          window.setTimeout(() => {
            btn.setButtonText(original);
          }, 1500);
        } catch {
          this.showError('Could not copy to clipboard. Select the words manually.');
        }
      });
    });

    let createBtnRef: HTMLButtonElement | null = null;

    new Setting(contentEl)
      .setName('I have saved my recovery phrase somewhere safe.')
      .addToggle((toggle) => {
        toggle.setValue(this.savedConfirmed).onChange((v) => {
          this.savedConfirmed = v;
          if (createBtnRef) {
            createBtnRef.disabled = !v || this.submitting;
          }
        });
      });

    this.errorEl = contentEl.createEl('div', {
      cls: 'mod-warning',
      attr: { style: 'display:none;margin:0.5em 0;' },
    });

    new Setting(contentEl)
      .addButton((btn) => {
        btn.setButtonText('Back');
        btn.onClick(() => {
          if (this.submitting) return;
          this.pendingSetup = null;
          this.recoveryPhrase = null;
          this.savedConfirmed = false;
          this.step = 1;
          this.renderStep();
        });
      })
      .addButton((btn) => {
        btn.setButtonText('Create vault').setCta();
        btn.onClick(() => void this.submitStep2());
        btn.buttonEl.disabled = !this.savedConfirmed;
        createBtnRef = btn.buttonEl;
        this.primaryBtn = btn.buttonEl;
      });
  }

  private renderStep3(): void {
    const { contentEl } = this;

    contentEl.createEl('h2', { text: 'Vault created' });
    contentEl.createEl('p', {
      text: "Your vault is now live and unlocked. You'll see sync activity in the status bar.",
      cls: 'setting-item-description',
    });

    new Setting(contentEl).addButton((btn) => {
      btn.setButtonText('Done').setCta();
      btn.onClick(() => this.close());
    });

    this.timeoutId = window.setTimeout(() => {
      this.timeoutId = null;
      this.close();
    }, 3000);
  }

  private async submitStep1(): Promise<void> {
    if (this.submitting) return;
    if (!this.password || !this.confirmPassword) {
      this.showError('Both password fields are required.');
      this.firstInputEl?.focus();
      return;
    }
    if (this.password.length < 12) {
      this.showError('Password must be at least 12 characters.');
      this.firstInputEl?.focus();
      return;
    }
    if (this.password !== this.confirmPassword) {
      this.showError('Passwords do not match.');
      this.firstInputEl?.focus();
      return;
    }

    this.submitting = true;
    this.hideError();
    if (this.primaryBtn) {
      this.primaryBtn.disabled = true;
      this.primaryBtn.textContent = 'Generating…';
    }

    try {
      const { recoveryPhrase, pendingSetup } =
        await this.plugin.generateVaultMaterial(this.password);
      this.recoveryPhrase = recoveryPhrase;
      this.pendingSetup = pendingSetup;
      this.savedConfirmed = false;
      this.step = 2;
      this.renderStep();
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      this.showError(this.friendlyError(raw));
      if (this.primaryBtn) {
        this.primaryBtn.disabled = false;
        this.primaryBtn.textContent = 'Continue';
      }
    } finally {
      this.submitting = false;
    }
  }

  private async submitStep2(): Promise<void> {
    if (this.submitting) return;
    if (!this.savedConfirmed) return;
    if (!this.pendingSetup) {
      this.showError('Missing setup material. Go back and try again.');
      return;
    }

    this.submitting = true;
    this.hideError();
    if (this.primaryBtn) {
      this.primaryBtn.disabled = true;
      this.primaryBtn.textContent = 'Creating vault…';
    }

    try {
      await this.plugin.commitVaultSetup(this.pendingSetup);
      this.pendingSetup = null;
      this.recoveryPhrase = null;
      this.step = 3;
      this.renderStep();
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      this.showError(this.friendlyError(raw));
      if (this.primaryBtn) {
        this.primaryBtn.disabled = !this.savedConfirmed;
        this.primaryBtn.textContent = 'Create vault';
      }
    } finally {
      this.submitting = false;
    }
  }

  private friendlyError(raw: string): string {
    const lower = raw.toLowerCase();
    if (lower.includes('already initialized') || lower.includes('409')) {
      return 'Vault already initialized for this nickname. Use Unlock instead.';
    }
    if (lower.includes('awaiting admin approval') || lower.includes('403')) {
      return 'Your account is awaiting admin approval on the server.';
    }
    if (lower.includes('too many requests') || lower.includes('429')) {
      return 'Too many attempts. Wait a few minutes and try again.';
    }
    if (lower.includes('invalid credentials') || lower.includes('401') || lower.includes('unauthorized')) {
      return 'Server rejected your credentials. Check the nickname (case-sensitive) and password in plugin settings match your Silent Stone account exactly.';
    }
    if (lower.includes('server url') || lower.includes('nickname must')) {
      return raw;
    }
    return `Setup failed: ${raw}`;
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
