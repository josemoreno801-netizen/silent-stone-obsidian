/**
 * Vault file watcher — listens for file changes and queues sync operations.
 *
 * TODO: Implement
 * - Register vault.on('modify'), vault.on('create'), vault.on('delete'), vault.on('rename')
 * - Debounce rapid changes (2s window)
 * - Filter out ignorePaths (e.g., .obsidian/**)
 * - Queue changed files for upload
 */

export class VaultWatcher {
  private changeQueue: string[] = [];

  getQueue(): string[] {
    return [...this.changeQueue];
  }

  clearQueue(): void {
    this.changeQueue = [];
  }
}
