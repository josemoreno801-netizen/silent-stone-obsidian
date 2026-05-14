import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AutoSyncController,
  type AutoSyncTrigger,
} from '../auto-sync';

/**
 * Build a minimal AutoSyncTrigger backed by a vi.fn().
 * The controller depends on the structural interface, not SyncEngine,
 * so no API client, manifest, or Obsidian shim is needed.
 */
function makeEngine(): { engine: AutoSyncTrigger; sync: ReturnType<typeof vi.fn> } {
  const sync = vi.fn().mockResolvedValue(undefined);
  return { engine: { sync }, sync };
}

/**
 * Build an engine whose sync() returns a manually-resolvable promise on the
 * first call. Used to model a sync that is "in-flight" while the controller
 * receives further notify() calls. Subsequent calls resolve immediately.
 */
function makeDeferredEngine(): {
  engine: AutoSyncTrigger;
  sync: ReturnType<typeof vi.fn>;
  resolveFirst: () => void;
} {
  let resolveFirst: () => void = () => {};
  const sync = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveFirst = resolve;
        }),
    )
    .mockResolvedValue(undefined);
  return { engine: { sync }, sync, resolveFirst: () => resolveFirst() };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('AutoSyncController — basic dispatch', () => {
  it('fires sync once after a single notify and the debounce window', async () => {
    const { engine, sync } = makeEngine();
    const ctrl = new AutoSyncController({ engine });
    ctrl.start();

    ctrl.notify();
    expect(sync).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);

    expect(sync).toHaveBeenCalledTimes(1);
  });

  it('coalesces rapid notifies into a single sync', async () => {
    const { engine, sync } = makeEngine();
    const ctrl = new AutoSyncController({ engine });
    ctrl.start();

    for (let i = 0; i < 5; i++) {
      ctrl.notify();
      await vi.advanceTimersByTimeAsync(100);
    }

    expect(sync).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);

    expect(sync).toHaveBeenCalledTimes(1);
  });

  it('respects a custom debounceMs', async () => {
    const { engine, sync } = makeEngine();
    const ctrl = new AutoSyncController({ engine, debounceMs: 1000 });
    ctrl.start();

    ctrl.notify();
    await vi.advanceTimersByTimeAsync(500);
    expect(sync).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);
    expect(sync).toHaveBeenCalledTimes(1);
  });
});

describe('AutoSyncController — start / stop gating', () => {
  it('ignores notify before start()', async () => {
    const { engine, sync } = makeEngine();
    const ctrl = new AutoSyncController({ engine });

    ctrl.notify();
    await vi.advanceTimersByTimeAsync(2000);

    expect(sync).not.toHaveBeenCalled();
  });

  it('detaches on stop() — pending notifies do not fire after toggle off', async () => {
    const { engine, sync } = makeEngine();
    const ctrl = new AutoSyncController({ engine });
    ctrl.start();

    ctrl.notify();
    ctrl.stop();
    await vi.advanceTimersByTimeAsync(2000);

    expect(sync).not.toHaveBeenCalled();
  });

  it('re-arms after stop() → start() — new notifies still fire', async () => {
    const { engine, sync } = makeEngine();
    const ctrl = new AutoSyncController({ engine });

    ctrl.start();
    ctrl.notify();
    ctrl.stop();
    await vi.advanceTimersByTimeAsync(2000);
    expect(sync).not.toHaveBeenCalled();

    ctrl.start();
    ctrl.notify();
    await vi.advanceTimersByTimeAsync(500);

    expect(sync).toHaveBeenCalledTimes(1);
  });
});

describe('AutoSyncController — in-flight re-entry guard', () => {
  it('fires a second sync if notify arrives during an in-flight sync', async () => {
    const { engine, sync, resolveFirst } = makeDeferredEngine();
    const ctrl = new AutoSyncController({ engine });
    ctrl.start();

    ctrl.notify();
    await vi.advanceTimersByTimeAsync(500);
    // First sync is now in-flight, awaiting on the deferred promise.
    expect(sync).toHaveBeenCalledTimes(1);

    // Notify during in-flight — should set the pending flag, not start a new sync yet.
    ctrl.notify();
    expect(sync).toHaveBeenCalledTimes(1);

    // Resolve the first sync. The controller's finally block should re-schedule.
    resolveFirst();
    await vi.advanceTimersByTimeAsync(500);

    expect(sync).toHaveBeenCalledTimes(2);
  });

  it('does not fire a late sync if stop() is called while in-flight with pending=true', async () => {
    const { engine, sync, resolveFirst } = makeDeferredEngine();
    const ctrl = new AutoSyncController({ engine });
    ctrl.start();

    ctrl.notify();
    await vi.advanceTimersByTimeAsync(500);
    expect(sync).toHaveBeenCalledTimes(1);

    // Set pending, then disarm before the in-flight resolves.
    ctrl.notify();
    ctrl.stop();

    resolveFirst();
    await vi.advanceTimersByTimeAsync(2000);

    // Only the original in-flight sync ran. No follow-up.
    expect(sync).toHaveBeenCalledTimes(1);
  });
});

describe('AutoSyncController — error handling', () => {
  it('forwards sync rejections to onError and does not enter a retry loop', async () => {
    const error = new Error('boom');
    const sync = vi.fn().mockRejectedValue(error);
    const onError = vi.fn();
    const ctrl = new AutoSyncController({ engine: { sync }, onError });
    ctrl.start();

    ctrl.notify();
    await vi.advanceTimersByTimeAsync(500);

    expect(sync).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(error);

    // Generously give the clock more room — controller must NOT auto-retry on its own.
    await vi.advanceTimersByTimeAsync(10_000);

    expect(sync).toHaveBeenCalledTimes(1);
  });

  it('survives a rejected sync — subsequent notifies still fire', async () => {
    const error = new Error('boom');
    const sync = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValue(undefined);
    const onError = vi.fn();
    const ctrl = new AutoSyncController({ engine: { sync }, onError });
    ctrl.start();

    ctrl.notify();
    await vi.advanceTimersByTimeAsync(500);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);

    ctrl.notify();
    await vi.advanceTimersByTimeAsync(500);

    expect(sync).toHaveBeenCalledTimes(2);
  });
});
