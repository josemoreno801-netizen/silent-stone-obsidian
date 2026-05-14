import { compileIgnorePrefixes, isIgnored } from './ignore';

/**
 * One unit of work for the sync engine.
 * Rename is decomposed into delete(oldPath) + upsert(newPath) at emit time.
 */
export type ChangeEvent =
  | { kind: 'upsert'; path: string }
  | { kind: 'delete'; path: string };

/** Minimal shape of an Obsidian TFile the watcher cares about. */
interface WatchedFile {
  path: string;
}

/**
 * Subset of Obsidian's Vault event API.
 * Typed loosely to avoid importing from `obsidian` (external at runtime).
 */
export interface VaultEventSource {
  on(event: string, cb: (...args: unknown[]) => void): unknown;
}

/** Subset of Obsidian's Plugin API for event cleanup. */
export interface EventRegistrar {
  registerEvent(ref: unknown): void;
}

export interface FileWatcherOptions {
  /** Glob-style ignore patterns, currently only `dir/**` prefix form is supported. */
  ignorePaths?: string[];
  /** Debounce window in ms. Defaults to 2000. */
  debounceMs?: number;
  /**
   * Called every time a path's per-path debounce expires and the event lands
   * in the settled queue. Used by the auto-sync controller to schedule syncs;
   * never invoked for ignored paths or for events still in the pending window.
   */
  onSettle?: () => void;
}

const DEFAULT_DEBOUNCE_MS = 2000;

/**
 * Listens to Obsidian vault events, debounces, and exposes a settled queue.
 * Keep this layer pure — no uploads, no crypto. The sync engine drains the queue.
 */
export class FileWatcher {
  private readonly ignorePrefixes: string[];
  private readonly debounceMs: number;
  private readonly onSettle?: () => void;
  private pending: Map<string, { event: ChangeEvent; timer: ReturnType<typeof setTimeout> }> =
    new Map();
  private queue: Map<string, ChangeEvent> = new Map();

  constructor(
    private readonly plugin: EventRegistrar,
    private readonly vault: VaultEventSource,
    opts: FileWatcherOptions = {},
  ) {
    this.ignorePrefixes = compileIgnorePrefixes(opts.ignorePaths);
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.onSettle = opts.onSettle;
  }

  start(): void {
    const register = (
      event: 'modify' | 'create' | 'delete' | 'rename',
      cb: (...args: unknown[]) => void,
    ) => {
      this.plugin.registerEvent(this.vault.on(event, cb));
    };

    register('modify', (file) => this.enqueue({ kind: 'upsert', path: (file as WatchedFile).path }));
    register('create', (file) => this.enqueue({ kind: 'upsert', path: (file as WatchedFile).path }));
    register('delete', (file) => this.enqueue({ kind: 'delete', path: (file as WatchedFile).path }));
    register('rename', (file, oldPath) => {
      this.enqueue({ kind: 'delete', path: oldPath as string });
      this.enqueue({ kind: 'upsert', path: (file as WatchedFile).path });
    });
  }

  getQueue(): ChangeEvent[] {
    return Array.from(this.queue.values());
  }

  clearQueue(): void {
    this.queue.clear();
  }

  private enqueue(event: ChangeEvent): void {
    if (this.isIgnored(event.path)) return;

    const existing = this.pending.get(event.path);
    if (existing) clearTimeout(existing.timer);

    const timer = setTimeout(() => {
      this.queue.set(event.path, event);
      this.pending.delete(event.path);
      this.onSettle?.();
    }, this.debounceMs);

    this.pending.set(event.path, { event, timer });
  }

  private isIgnored(path: string): boolean {
    return isIgnored(path, this.ignorePrefixes);
  }
}
