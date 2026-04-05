/**
 * Sync engine — orchestrates diff, upload, and download operations.
 *
 * TODO: Implement
 * - diffLocalVsServer(): Compare vault files with server file list
 * - uploadChanges(): Push modified local files to server
 * - downloadChanges(): Pull new/modified server files to vault
 * - resolveConflicts(): Handle files changed on both sides
 */

import type { SyncState } from '../types';

export class SyncEngine {
  private state: SyncState = { files: {}, lastFullSync: '' };

  getState(): SyncState {
    return this.state;
  }

  setState(state: SyncState): void {
    this.state = state;
  }
}
