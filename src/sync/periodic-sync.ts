/**
 * Periodic sync controller. Owns a repeating timer that calls `engine.sync()`
 * every `intervalMs` milliseconds. Skips the tick if a sync is already in
 * flight (no overlap). Lifecycle is `start(intervalMs)` / `stop()` —
 * `setIntervalMs(ms)` is a convenience for changing cadence without losing
 * the in-progress flag.
 *
 * Mirrors `AutoSyncController` (LOC-14): same structural engine interface,
 * same onError contract, same "controller never throws" guarantee.
 */

export interface PeriodicSyncTrigger {
  sync(): Promise<void>;
}

export interface PeriodicSyncControllerOpts {
  engine: PeriodicSyncTrigger;
  /** Called when `engine.sync()` rejects. Never rethrown from the controller. */
  onError?: (err: unknown) => void;
}

export class PeriodicSyncController {
  private readonly engine: PeriodicSyncTrigger;
  private readonly onError?: (err: unknown) => void;

  private active = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inProgress = false;

  constructor(opts: PeriodicSyncControllerOpts) {
    this.engine = opts.engine;
    this.onError = opts.onError;
  }

  /** Arm the controller and begin firing every `intervalMs`. Replaces any existing timer. */
  start(intervalMs: number): void {
    this.stop();
    this.active = true;
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
  }

  /** Disarm. Clears the interval. A sync already in-flight finishes naturally. */
  stop(): void {
    this.active = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Change cadence. No-op when stopped — plugin re-reads settings on next start(). */
  setIntervalMs(intervalMs: number): void {
    if (!this.active) return;
    this.start(intervalMs);
  }

  private async tick(): Promise<void> {
    if (!this.active) return;
    if (this.inProgress) return;

    this.inProgress = true;
    try {
      await this.engine.sync();
    } catch (err) {
      this.onError?.(err);
    } finally {
      this.inProgress = false;
    }
  }
}
