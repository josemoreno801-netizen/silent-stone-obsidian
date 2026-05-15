import { App, Modal, Setting } from 'obsidian';
import type { ConflictInfo, ConflictResolution } from '../sync/engine';

export interface ConflictModalChoice {
  resolution: ConflictResolution;
  applyToAll: boolean;
}

export interface ConflictModalOpts {
  /**
   * Called exactly once: when the user picks an action OR closes the modal
   * without choosing. `null` means "no decision" — the handler factory should
   * default that to the safe choice (preserve local).
   */
  onResolve: (choice: ConflictModalChoice | null) => void;
}

/**
 * Conflict resolution modal — opened when the engine's divergence detector
 * finds that both sides changed since the last sync AND the user's chosen
 * strategy is `'ask'`. Resolves with the user's per-file choice and an
 * `applyToAll` flag the handler factory uses to short-circuit the rest of
 * this sync round.
 */
export class ConflictModal extends Modal {
  private readonly info: ConflictInfo;
  private readonly localModifiedAt: number;
  private readonly opts: ConflictModalOpts;
  private applyToAll = false;
  private resolved = false;

  constructor(app: App, info: ConflictInfo, localModifiedAt: number, opts: ConflictModalOpts) {
    super(app);
    this.info = info;
    this.localModifiedAt = localModifiedAt;
    this.opts = opts;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h2', { text: 'Resolve sync conflict' });
    contentEl.createEl('p', {
      text: this.info.path,
      cls: 'setting-item-description',
    });
    contentEl.createEl('p', {
      text: `Local modified: ${new Date(this.localModifiedAt).toISOString()}`,
      cls: 'setting-item-description',
    });
    contentEl.createEl('p', {
      text: `Server modified: ${new Date(this.info.serverModifiedAt).toISOString()}`,
      cls: 'setting-item-description',
    });

    new Setting(contentEl)
      .setName('Apply this choice to all remaining conflicts')
      .setDesc('Skip applies per-file regardless.')
      .addToggle((t) =>
        t.setValue(false).onChange((v) => {
          this.applyToAll = v;
        }),
      );

    new Setting(contentEl)
      .addButton((btn) =>
        btn
          .setButtonText('Keep Local')
          .setCta()
          .onClick(() => this.pick('keep-local')),
      )
      .addButton((btn) =>
        btn.setButtonText('Take Server').onClick(() => this.pick('keep-server')),
      )
      .addButton((btn) =>
        btn.setButtonText('Keep Both').onClick(() => this.pick('keep-both')),
      )
      .addButton((btn) =>
        btn.setButtonText('Skip').onClick(() => this.skip()),
      );
  }

  onClose(): void {
    // If the user dismissed the modal (Esc, click outside) without picking,
    // hand back null so the handler factory falls through to its safe default.
    // Otherwise the engine's await would hang forever.
    if (!this.resolved) {
      this.resolved = true;
      this.opts.onResolve(null);
    }
    this.contentEl.empty();
  }

  private pick(resolution: ConflictResolution): void {
    if (this.resolved) return;
    this.resolved = true;
    this.opts.onResolve({ resolution, applyToAll: this.applyToAll });
    this.close();
  }

  private skip(): void {
    if (this.resolved) return;
    this.resolved = true;
    // Skip is a per-file deferral. Even if "apply to all" is checked, we
    // ignore it — the user is explicitly saying "don't decide globally."
    this.opts.onResolve({ resolution: 'keep-local', applyToAll: false });
    this.close();
  }
}
