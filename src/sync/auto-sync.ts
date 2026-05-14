/**
 * Auto-sync controller. Sits between the FileWatcher and the SyncEngine,
 * owning the *trigger policy* — when to fire a sync, when to coalesce, and
 * when to skip because one is already in flight.
 *
 * The watcher debounces vault events per-path (2s default). Each settled
 * path-event calls `notify()`. The controller applies its own short debounce
 * (500ms default) so simultaneous multi-file settles produce one sync trigger
 * instead of one per file.
 *
 * Lifecycle is gated by `start()` / `stop()` — toggling auto-sync off detaches
 * the controller but leaves the watcher running, so the queue keeps capturing
 * changes and a manual sync still picks them up.
 */

/**
 * Minimal structural type the controller needs from the sync engine.
 * `SyncEngine` satisfies this — using a narrow interface keeps tests free of
 * Obsidian, API client, and manifest mocks.
 */
export interface AutoSyncTrigger {
  sync(): Promise<void>;
}

export interface AutoSyncControllerOpts {
  engine: AutoSyncTrigger;
  /** Debounce window applied on top of the watcher's per-path debounce. Default 500ms. */
  debounceMs?: number;
  /** Called when `engine.sync()` rejects. Never rethrown from the controller. */
  onError?: (err: unknown) => void;
}

const DEFAULT_DEBOUNCE_MS = 500;

export class AutoSyncController {
  private readonly engine: AutoSyncTrigger;
  private readonly debounceMs: number;
  private readonly onError?: (err: unknown) => void;

  private active = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inProgress = false;
  /** Set when notify() arrives during an in-flight sync. Drains in fire()'s finally block. */
  private pending = false;

  constructor(opts: AutoSyncControllerOpts) {
    this.engine = opts.engine;
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.onError = opts.onError;
  }

  /** Arm the controller. Subsequent notify() calls schedule syncs. */
  start(): void {
    this.active = true;
  }

  /**
   * Disarm. Clears any scheduled timer and drops the pending flag so a
   * sync that finishes after stop() does not enqueue another round.
   */
  stop(): void {
    this.active = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending = false;
  }

  /**
   * Called by the watcher when a path's per-path debounce settles.
   * During an in-flight sync this just sets a pending flag — the in-flight
   * sync's finally block re-schedules. Otherwise it resets the debounce timer.
   */
  notify(): void {
    if (!this.active) return;

    if (this.inProgress) {
      this.pending = true;
      return;
    }

    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.fire();
    }, this.debounceMs);
  }

  private async fire(): Promise<void> {
    this.timer = null;
    if (!this.active) return;

    this.inProgress = true;
    try {
      await this.engine.sync();
    } catch (err) {
      this.onError?.(err);
    } finally {
      this.inProgress = false;
      if (this.pending && this.active) {
        this.pending = false;
        this.timer = setTimeout(() => {
          void this.fire();
        }, this.debounceMs);
      }
    }
  }
}
