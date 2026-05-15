import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PeriodicSyncController,
  type PeriodicSyncTrigger,
} from '../periodic-sync';

function makeEngine(): { engine: PeriodicSyncTrigger; sync: ReturnType<typeof vi.fn> } {
  const sync = vi.fn().mockResolvedValue(undefined);
  return { engine: { sync }, sync };
}

function makeDeferredEngine(): {
  engine: PeriodicSyncTrigger;
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

describe('PeriodicSyncController — basic dispatch', () => {
  it('does not fire before start()', async () => {
    const { engine, sync } = makeEngine();
    new PeriodicSyncController({ engine });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(sync).not.toHaveBeenCalled();
  });

  it('fires sync once per interval after start()', async () => {
    const { engine, sync } = makeEngine();
    const ctrl = new PeriodicSyncController({ engine });

    ctrl.start(1_000);

    expect(sync).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sync).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(sync).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(sync).toHaveBeenCalledTimes(3);
  });
});

describe('PeriodicSyncController — start / stop gating', () => {
  it('stop() clears the interval; no further syncs', async () => {
    const { engine, sync } = makeEngine();
    const ctrl = new PeriodicSyncController({ engine });

    ctrl.start(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sync).toHaveBeenCalledTimes(1);

    ctrl.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it('re-arms after stop() → start() — new interval fires', async () => {
    const { engine, sync } = makeEngine();
    const ctrl = new PeriodicSyncController({ engine });

    ctrl.start(1_000);
    ctrl.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sync).not.toHaveBeenCalled();

    ctrl.start(500);
    await vi.advanceTimersByTimeAsync(500);
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it('start() while already active replaces the existing timer', async () => {
    const { engine, sync } = makeEngine();
    const ctrl = new PeriodicSyncController({ engine });

    ctrl.start(1_000);
    await vi.advanceTimersByTimeAsync(500); // partway through original tick

    ctrl.start(2_000); // restart with new interval, drop pending tick

    await vi.advanceTimersByTimeAsync(500); // original would have fired here
    expect(sync).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_500); // 2s total since restart
    expect(sync).toHaveBeenCalledTimes(1);
  });
});

describe('PeriodicSyncController — settings change via setIntervalMs', () => {
  it('setIntervalMs while active restarts the interval at the new cadence', async () => {
    const { engine, sync } = makeEngine();
    const ctrl = new PeriodicSyncController({ engine });

    ctrl.start(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sync).toHaveBeenCalledTimes(1);

    ctrl.setIntervalMs(500);
    await vi.advanceTimersByTimeAsync(500);
    expect(sync).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(500);
    expect(sync).toHaveBeenCalledTimes(3);
  });

  it('setIntervalMs while stopped does not start the timer', async () => {
    const { engine, sync } = makeEngine();
    const ctrl = new PeriodicSyncController({ engine });

    ctrl.setIntervalMs(500);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sync).not.toHaveBeenCalled();
  });
});

describe('PeriodicSyncController — in-flight re-entry guard', () => {
  it('skips a tick if the previous sync is still running', async () => {
    const { engine, sync, resolveFirst } = makeDeferredEngine();
    const ctrl = new PeriodicSyncController({ engine });

    ctrl.start(1_000);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(sync).toHaveBeenCalledTimes(1); // first tick: in flight

    await vi.advanceTimersByTimeAsync(1_000);
    expect(sync).toHaveBeenCalledTimes(1); // second tick: skipped, first still pending

    await vi.advanceTimersByTimeAsync(1_000);
    expect(sync).toHaveBeenCalledTimes(1); // third tick: still skipped

    resolveFirst();
    await vi.advanceTimersByTimeAsync(0); // let the finally block run

    await vi.advanceTimersByTimeAsync(1_000);
    expect(sync).toHaveBeenCalledTimes(2); // next tick after resolution: fires
  });
});

describe('PeriodicSyncController — error handling', () => {
  it('forwards sync rejections to onError and continues ticking', async () => {
    const error = new Error('boom');
    const sync = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValue(undefined);
    const onError = vi.fn();
    const ctrl = new PeriodicSyncController({ engine: { sync }, onError });

    ctrl.start(1_000);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(sync).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(error);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(sync).toHaveBeenCalledTimes(2);
  });
});
