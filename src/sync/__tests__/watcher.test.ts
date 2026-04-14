import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FileWatcher,
  type ChangeEvent,
  type EventRegistrar,
  type VaultEventSource,
} from '../watcher';

type Handler = (...args: unknown[]) => void;

/**
 * Test double for Obsidian's Vault event source.
 * `emit()` invokes whatever handler the watcher registered for that event.
 */
class FakeVault implements VaultEventSource {
  handlers: Record<string, Handler> = {};

  on(event: string, cb: Handler): { event: string } {
    this.handlers[event] = cb;
    return { event };
  }

  emit(event: string, ...args: unknown[]): void {
    const handler = this.handlers[event];
    if (handler) handler(...args);
  }
}

class FakePlugin implements EventRegistrar {
  registered: unknown[] = [];
  registerEvent(ref: unknown): void {
    this.registered.push(ref);
  }
}

function makeFile(path: string): { path: string } {
  return { path };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('FileWatcher — lifecycle', () => {
  it('registers modify, create, delete, and rename handlers with the plugin on start()', () => {
    const vault = new FakeVault();
    const plugin = new FakePlugin();
    const watcher = new FileWatcher(plugin, vault);

    watcher.start();

    expect(Object.keys(vault.handlers).sort()).toEqual([
      'create',
      'delete',
      'modify',
      'rename',
    ]);
    expect(plugin.registered).toHaveLength(4);
  });
});

describe('FileWatcher — debounce', () => {
  it('queues a single upsert after the debounce window settles', () => {
    const vault = new FakeVault();
    const watcher = new FileWatcher(new FakePlugin(), vault);
    watcher.start();

    vault.emit('modify', makeFile('note.md'));
    expect(watcher.getQueue()).toEqual([]);

    vi.advanceTimersByTime(2000);

    expect(watcher.getQueue()).toEqual<ChangeEvent[]>([
      { kind: 'upsert', path: 'note.md' },
    ]);
  });

  it('coalesces rapid repeated modifies into one queue entry', () => {
    const vault = new FakeVault();
    const watcher = new FileWatcher(new FakePlugin(), vault);
    watcher.start();

    vault.emit('modify', makeFile('note.md'));
    vi.advanceTimersByTime(500);
    vault.emit('modify', makeFile('note.md'));
    vi.advanceTimersByTime(500);
    vault.emit('modify', makeFile('note.md'));
    vi.advanceTimersByTime(2000);

    expect(watcher.getQueue()).toEqual<ChangeEvent[]>([
      { kind: 'upsert', path: 'note.md' },
    ]);
  });

  it('keeps separate paths separate in the queue', () => {
    const vault = new FakeVault();
    const watcher = new FileWatcher(new FakePlugin(), vault);
    watcher.start();

    vault.emit('modify', makeFile('a.md'));
    vault.emit('modify', makeFile('b.md'));
    vi.advanceTimersByTime(2000);

    const queue = watcher.getQueue();
    expect(queue).toHaveLength(2);
    expect(queue.map((e) => e.path).sort()).toEqual(['a.md', 'b.md']);
  });
});

describe('FileWatcher — event kinds', () => {
  it('emits a delete event for vault delete', () => {
    const vault = new FakeVault();
    const watcher = new FileWatcher(new FakePlugin(), vault);
    watcher.start();

    vault.emit('delete', makeFile('old.md'));
    vi.advanceTimersByTime(2000);

    expect(watcher.getQueue()).toEqual<ChangeEvent[]>([
      { kind: 'delete', path: 'old.md' },
    ]);
  });

  it('splits rename into delete(oldPath) + upsert(newPath)', () => {
    const vault = new FakeVault();
    const watcher = new FileWatcher(new FakePlugin(), vault);
    watcher.start();

    vault.emit('rename', makeFile('new-name.md'), 'old-name.md');
    vi.advanceTimersByTime(2000);

    const queue = watcher.getQueue();
    const sorted = [...queue].sort((a, b) => a.path.localeCompare(b.path));
    expect(sorted).toEqual<ChangeEvent[]>([
      { kind: 'upsert', path: 'new-name.md' },
      { kind: 'delete', path: 'old-name.md' },
    ]);
  });

  it('treats create the same as upsert', () => {
    const vault = new FakeVault();
    const watcher = new FileWatcher(new FakePlugin(), vault);
    watcher.start();

    vault.emit('create', makeFile('brand-new.md'));
    vi.advanceTimersByTime(2000);

    expect(watcher.getQueue()).toEqual<ChangeEvent[]>([
      { kind: 'upsert', path: 'brand-new.md' },
    ]);
  });
});

describe('FileWatcher — ignore patterns', () => {
  it('filters paths matching dir/** patterns from the default ignore list', () => {
    const vault = new FakeVault();
    const watcher = new FileWatcher(new FakePlugin(), vault);
    watcher.start();

    vault.emit('modify', makeFile('.obsidian/workspace.json'));
    vault.emit('modify', makeFile('.trash/deleted.md'));
    vault.emit('modify', makeFile('.git/HEAD'));
    vault.emit('modify', makeFile('kept.md'));
    vi.advanceTimersByTime(2000);

    const queue = watcher.getQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0]).toEqual({ kind: 'upsert', path: 'kept.md' });
  });

  it('honors custom ignore patterns passed in options', () => {
    const vault = new FakeVault();
    const watcher = new FileWatcher(new FakePlugin(), vault, {
      ignorePaths: ['private/**'],
    });
    watcher.start();

    vault.emit('modify', makeFile('private/secret.md'));
    vault.emit('modify', makeFile('public.md'));
    vi.advanceTimersByTime(2000);

    const queue = watcher.getQueue();
    expect(queue.map((e) => e.path)).toEqual(['public.md']);
  });
});

describe('FileWatcher — queue drain', () => {
  it('clearQueue empties the queue without affecting future events', () => {
    const vault = new FakeVault();
    const watcher = new FileWatcher(new FakePlugin(), vault);
    watcher.start();

    vault.emit('modify', makeFile('a.md'));
    vi.advanceTimersByTime(2000);
    expect(watcher.getQueue()).toHaveLength(1);

    watcher.clearQueue();
    expect(watcher.getQueue()).toEqual([]);

    vault.emit('modify', makeFile('b.md'));
    vi.advanceTimersByTime(2000);
    expect(watcher.getQueue()).toEqual<ChangeEvent[]>([
      { kind: 'upsert', path: 'b.md' },
    ]);
  });
});
