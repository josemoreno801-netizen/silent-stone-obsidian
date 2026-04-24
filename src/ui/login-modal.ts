import { App, Modal, Setting } from 'obsidian';
import type SilentStoneSyncPlugin from '../main';

const DEFAULT_SERVER_URL = 'https://silentstone.one';
const SIGNUP_URL = 'https://silentstone.one/signup';

export class LoginModal extends Modal {
  private plugin: SilentStoneSyncPlugin;
  private nickname = '';
  private password = '';
  private submitting = false;
  private errorEl: HTMLElement | null = null;
  private submitBtn: HTMLButtonElement | null = null;
  private nicknameInputEl: HTMLInputElement | null = null;
  private passwordInputEl: HTMLInputElement | null = null;

  constructor(app: App, plugin: SilentStoneSyncPlugin) {
    super(app);
    this.plugin = plugin;
    this.nickname = plugin.settings.nickname ?? '';
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h2', { text: 'Sign in to Silent Stone' });
    contentEl.createEl('p', {
      text: 'Log in to your account to start syncing your vault.',
      cls: 'setting-item-description',
    });

    new Setting(contentEl).setName('Nickname').addText((text) => {
      text
        .setPlaceholder('your nickname')
        .setValue(this.nickname)
        .onChange((v) => {
          this.nickname = v;
        });
      text.inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this.passwordInputEl?.focus();
        }
      });
      this.nicknameInputEl = text.inputEl;
    });

    new Setting(contentEl).setName('Password').addText((text) => {
      text.setPlaceholder('password').onChange((v) => {
        this.password = v;
      });
      text.inputEl.type = 'password';
      text.inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          void this.submit();
        }
      });
      this.passwordInputEl = text.inputEl;
    });

    this.errorEl = contentEl.createEl('div', {
      cls: 'mod-warning',
      attr: { style: 'display:none;margin:0.5em 0;' },
    });

    new Setting(contentEl)
      .addButton((btn) => {
        btn.setButtonText('Log in').setCta();
        btn.onClick(() => void this.submit());
        this.submitBtn = btn.buttonEl;
      })
      .addButton((btn) => {
        btn.setButtonText('Cancel');
        btn.onClick(() => this.close());
      });

    const linkRow = contentEl.createEl('p', {
      cls: 'setting-item-description',
      attr: { style: 'text-align:center;margin-top:1em;' },
    });
    linkRow.createEl('span', { text: "Don't have an account? " });
    const link = linkRow.createEl('a', {
      text: 'Create one',
      attr: {
        href: SIGNUP_URL,
        target: '_blank',
        rel: 'noopener',
      },
    });
    link.addEventListener('click', (e) => {
      e.preventDefault();
      window.open(SIGNUP_URL, '_blank');
    });

    queueMicrotask(() => {
      if (this.nickname) this.passwordInputEl?.focus();
      else this.nicknameInputEl?.focus();
    });
  }

  onClose(): void {
    this.password = '';
    this.contentEl.empty();
  }

  private async submit(): Promise<void> {
    if (this.submitting) return;
    const nickname = this.nickname.trim();
    if (!nickname) {
      this.showError('Nickname required.');
      return;
    }
    if (!this.password) {
      this.showError('Password required.');
      return;
    }

    this.submitting = true;
    this.hideError();
    if (this.submitBtn) {
      this.submitBtn.disabled = true;
      this.submitBtn.textContent = 'Signing in…';
    }

    try {
      if (!this.plugin.settings.serverUrl) {
        this.plugin.settings.serverUrl = DEFAULT_SERVER_URL;
      }
      this.plugin.settings.nickname = nickname;
      await this.plugin.saveSettings();

      await this.plugin.unlockVaultWithPassword(this.password);
      this.close();
    } catch (e) {
      this.showError(this.friendlyError(e));
      if (this.passwordInputEl) {
        this.passwordInputEl.value = '';
        this.passwordInputEl.focus();
      }
      this.password = '';
    } finally {
      this.submitting = false;
      if (this.submitBtn) {
        this.submitBtn.disabled = false;
        this.submitBtn.textContent = 'Log in';
      }
    }
  }

  private friendlyError(err: unknown): string {
    const statusObj = err as { status?: number } | null;
    if (statusObj && typeof statusObj.status === 'number') {
      if (statusObj.status === 401) return 'Wrong nickname or password.';
      if (statusObj.status === 403) return 'Account pending approval or suspended.';
      if (statusObj.status === 429) return 'Too many attempts. Wait a minute and try again.';
    }

    const raw = err instanceof Error ? err.message : String(err);
    const lower = raw.toLowerCase();

    if (lower.includes('vault keys not set up')) {
      return 'No vault yet. Run "Vault: first-time setup" from the command palette.';
    }
    if (
      lower.includes('failed to fetch') ||
      lower.includes('network') ||
      lower.includes('enotfound') ||
      lower.includes('econnrefused') ||
      lower.includes('fetch failed')
    ) {
      return "Can't reach Silent Stone. Check your connection and server URL.";
    }
    return `Sign in failed: ${raw}`;
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
