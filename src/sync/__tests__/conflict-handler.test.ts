import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createConflictHandler } from '../conflict-handler';
import type { ConflictInfo } from '../engine';
import type { ConflictModalChoice } from '../../ui/sync-modal';

function makeInfo(path: string): ConflictInfo {
  return {
    path,
    localHash: 'a',
    serverHash: 'b',
    lastKnownHash: 'c',
    localContent: new ArrayBuffer(0),
    serverContent: new ArrayBuffer(0),
    serverModifiedAt: 0,
  };
}

type StrategyValue = 'ask' | 'keep-local' | 'keep-server' | 'keep-both';

function buildHandler(opts: {
  strategy: StrategyValue;
  modalChoices?: (ConflictModalChoice | null)[];
}) {
  const queue = [...(opts.modalChoices ?? [])];
  const openConflictModal = vi.fn().mockImplementation(async () => {
    if (queue.length === 0) throw new Error('test ran out of mocked modal choices');
    return queue.shift()!;
  });
  const getStrategy = vi.fn(() => opts.strategy);
  const factory = createConflictHandler({ getStrategy, openConflictModal });
  return { ...factory, openConflictModal, getStrategy };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Strategy short-circuit ─────────────────────────
describe('createConflictHandler — non-ask strategies', () => {
  it('returns "keep-local" without opening the modal', async () => {
    const h = buildHandler({ strategy: 'keep-local' });
    const result = await h.handler(makeInfo('a.md'));
    expect(result).toBe('keep-local');
    expect(h.openConflictModal).not.toHaveBeenCalled();
  });

  it('returns "keep-server" without opening the modal', async () => {
    const h = buildHandler({ strategy: 'keep-server' });
    const result = await h.handler(makeInfo('a.md'));
    expect(result).toBe('keep-server');
    expect(h.openConflictModal).not.toHaveBeenCalled();
  });

  it('returns "keep-both" without opening the modal', async () => {
    const h = buildHandler({ strategy: 'keep-both' });
    const result = await h.handler(makeInfo('a.md'));
    expect(result).toBe('keep-both');
    expect(h.openConflictModal).not.toHaveBeenCalled();
  });
});

// ── Ask: per-file modal flow ───────────────────────
describe('createConflictHandler — ask, single file', () => {
  it('opens the modal and returns the user-picked resolution', async () => {
    const h = buildHandler({
      strategy: 'ask',
      modalChoices: [{ resolution: 'keep-server', applyToAll: false }],
    });
    const result = await h.handler(makeInfo('a.md'));
    expect(h.openConflictModal).toHaveBeenCalledOnce();
    expect(result).toBe('keep-server');
  });

  it('treats a null modal choice (dismissed) as keep-local (safe default)', async () => {
    const h = buildHandler({ strategy: 'ask', modalChoices: [null] });
    const result = await h.handler(makeInfo('a.md'));
    expect(result).toBe('keep-local');
  });
});

// ── Ask: batch / apply-to-all ──────────────────────
describe('createConflictHandler — ask, batch with apply-to-all', () => {
  it('opens modal once when first choice is applyToAll, then short-circuits', async () => {
    const h = buildHandler({
      strategy: 'ask',
      modalChoices: [{ resolution: 'keep-server', applyToAll: true }],
    });

    const a = await h.handler(makeInfo('a.md'));
    const b = await h.handler(makeInfo('b.md'));
    const c = await h.handler(makeInfo('c.md'));

    expect(a).toBe('keep-server');
    expect(b).toBe('keep-server');
    expect(c).toBe('keep-server');
    expect(h.openConflictModal).toHaveBeenCalledOnce();
  });

  it('opens modal per-file when applyToAll stays false', async () => {
    const h = buildHandler({
      strategy: 'ask',
      modalChoices: [
        { resolution: 'keep-local', applyToAll: false },
        { resolution: 'keep-server', applyToAll: false },
        { resolution: 'keep-both', applyToAll: false },
      ],
    });

    const a = await h.handler(makeInfo('a.md'));
    const b = await h.handler(makeInfo('b.md'));
    const c = await h.handler(makeInfo('c.md'));

    expect(a).toBe('keep-local');
    expect(b).toBe('keep-server');
    expect(c).toBe('keep-both');
    expect(h.openConflictModal).toHaveBeenCalledTimes(3);
  });

  it('reset() clears the apply-to-all memory so the next call opens the modal again', async () => {
    const h = buildHandler({
      strategy: 'ask',
      modalChoices: [
        { resolution: 'keep-server', applyToAll: true },
        { resolution: 'keep-local', applyToAll: false },
      ],
    });

    await h.handler(makeInfo('a.md')); // opens modal, sets appliedToAll
    await h.handler(makeInfo('b.md')); // short-circuit
    h.reset();
    const c = await h.handler(makeInfo('c.md')); // opens modal again

    expect(c).toBe('keep-local');
    expect(h.openConflictModal).toHaveBeenCalledTimes(2);
  });

  it('honors a strategy switch between calls (non-ask wins, modal not opened)', async () => {
    const choices: (ConflictModalChoice | null)[] = [
      { resolution: 'keep-server', applyToAll: false },
    ];
    const openConflictModal = vi.fn().mockImplementation(async () => choices.shift());
    let strategy: StrategyValue = 'ask';
    const getStrategy = () => strategy;
    const { handler } = createConflictHandler({ getStrategy, openConflictModal });

    expect(await handler(makeInfo('a.md'))).toBe('keep-server');
    strategy = 'keep-local';
    expect(await handler(makeInfo('b.md'))).toBe('keep-local');
    expect(openConflictModal).toHaveBeenCalledOnce();
  });
});
