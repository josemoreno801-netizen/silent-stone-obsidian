import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock `obsidian` ────────────────────────────────
// ConflictModal extends Obsidian's Modal and uses Setting builders for its
// button row + apply-to-all toggle. We hand-roll the same minimal widget
// surface unlock-modal.test uses, plus addToggle (the conflict modal needs
// a checkbox, unlock didn't).
const { MockModal, MockSetting, lastSettings } = vi.hoisted(() => {
  type FakeButtonEl = { disabled: boolean; textContent: string };

  type FakeEl = {
    tagName: string;
    textContent: string;
    children: FakeEl[];
    cls: string[];
    style: Record<string, string>;
    attrs: Record<string, string>;
    createEl: (
      tag: string,
      opts?: { text?: string; cls?: string; attr?: Record<string, string> },
    ) => FakeEl;
    setText: (t: string) => void;
    empty: () => void;
  };

  type ButtonHandler = {
    label: string;
    buttonEl: FakeButtonEl;
    onClick?: () => void | Promise<void>;
    isCta: boolean;
    isWarning: boolean;
  };

  type ToggleHandler = {
    value: boolean;
    onChange?: (v: boolean) => void;
  };

  type Handlers = {
    name: string;
    desc: string;
    buttonHandlers: ButtonHandler[];
    toggleHandlers: ToggleHandler[];
  };

  const allSettings: Handlers[] = [];

  function createFakeEl(tag: string): FakeEl {
    const el: FakeEl = {
      tagName: tag.toUpperCase(),
      textContent: '',
      children: [],
      cls: [],
      style: {},
      attrs: {},
      createEl: (t, opts) => {
        const child = createFakeEl(t);
        if (opts?.text) child.textContent = opts.text;
        if (opts?.cls) {
          for (const c of opts.cls.split(/\s+/)) child.cls.push(c);
        }
        if (opts?.attr) {
          for (const [k, v] of Object.entries(opts.attr)) child.attrs[k] = v;
        }
        el.children.push(child);
        return child;
      },
      setText: (t) => {
        el.textContent = t;
      },
      empty: () => {
        el.children = [];
        el.textContent = '';
      },
    };
    return el;
  }

  class MockModal {
    app: unknown;
    contentEl: FakeEl;
    close: ReturnType<typeof vi.fn>;

    constructor(app: unknown) {
      this.app = app;
      this.contentEl = createFakeEl('div');
      this.close = vi.fn();
    }

    open(): void {
      (this as unknown as { onOpen?: () => void }).onOpen?.();
    }
  }

  class MockSetting {
    private handlers: Handlers;

    constructor(_parent: unknown) {
      this.handlers = {
        name: '',
        desc: '',
        buttonHandlers: [],
        toggleHandlers: [],
      };
      allSettings.push(this.handlers);
    }

    setName(name: string): this {
      this.handlers.name = name;
      return this;
    }

    setDesc(desc: string): this {
      this.handlers.desc = desc;
      return this;
    }

    addButton(cb: (b: unknown) => void): this {
      const buttonEl: FakeButtonEl = { disabled: false, textContent: '' };
      const captured: ButtonHandler = {
        label: '',
        buttonEl,
        isCta: false,
        isWarning: false,
      };
      const api = {
        setButtonText: (t: string) => {
          captured.label = t;
          buttonEl.textContent = t;
          return api;
        },
        setCta: () => {
          captured.isCta = true;
          return api;
        },
        setWarning: () => {
          captured.isWarning = true;
          return api;
        },
        onClick: (fn: () => void | Promise<void>) => {
          captured.onClick = fn;
          return api;
        },
        buttonEl,
      };
      cb(api);
      this.handlers.buttonHandlers.push(captured);
      return this;
    }

    addToggle(cb: (t: unknown) => void): this {
      const captured: ToggleHandler = { value: false };
      const api = {
        setValue: (v: boolean) => {
          captured.value = v;
          return api;
        },
        onChange: (fn: (v: boolean) => void) => {
          captured.onChange = fn;
          return api;
        },
      };
      cb(api);
      this.handlers.toggleHandlers.push(captured);
      return this;
    }
  }

  function lastSettings(): Handlers[] {
    return allSettings;
  }

  return { MockModal, MockSetting, lastSettings };
});

vi.mock('obsidian', () => ({
  App: class {},
  Modal: MockModal,
  Setting: MockSetting,
}));

import { ConflictModal, type ConflictModalChoice } from '../sync-modal';
import type { ConflictInfo } from '../../sync/engine';

// ── Fixtures ───────────────────────────────────────
function makeConflictInfo(overrides: Partial<ConflictInfo> = {}): ConflictInfo {
  const enc = new TextEncoder();
  return {
    path: 'notes/foo.md',
    localHash: 'aaaaaaaaaaaa',
    serverHash: 'bbbbbbbbbbbb',
    lastKnownHash: 'cccccccccccc',
    localContent: enc.encode('local body').buffer,
    serverContent: enc.encode('server body').buffer,
    serverModifiedAt: 1_700_000_000_000,
    ...overrides,
  };
}

type Choices = (ConflictModalChoice | null)[];

function openModal(
  info: ConflictInfo = makeConflictInfo(),
  localModifiedAt = 1_700_000_050_000,
): { modal: ConflictModal; choices: Choices } {
  const choices: Choices = [];
  const modal = new ConflictModal({} as never, info, localModifiedAt, {
    onResolve: (c) => choices.push(c),
  });
  (modal as unknown as { open: () => void }).open();
  return { modal, choices };
}

type TreeNode = { textContent: string; children: TreeNode[] };

function findByText(el: unknown, needle: string): boolean {
  const node = el as TreeNode;
  if ((node.textContent ?? '').includes(needle)) return true;
  for (const c of node.children ?? []) {
    if (findByText(c, needle)) return true;
  }
  return false;
}

function allButtons() {
  return lastSettings().flatMap((s) => s.buttonHandlers);
}

function clickButton(label: string): void {
  const btn = allButtons().find((b) => b.label === label);
  if (!btn) {
    const labels = allButtons().map((b) => b.label).join(', ');
    throw new Error(`No button labeled "${label}". Found: [${labels}]`);
  }
  void btn.onClick?.();
}

function setApplyToAll(value: boolean): void {
  const toggle = lastSettings().flatMap((s) => s.toggleHandlers)[0];
  if (!toggle) throw new Error('No apply-to-all toggle rendered');
  toggle.value = value;
  toggle.onChange?.(value);
}

beforeEach(() => {
  const all = lastSettings();
  all.length = 0;
  vi.clearAllMocks();
});

// ── Render ─────────────────────────────────────────
describe('ConflictModal — render', () => {
  it('shows the file path in the modal body', () => {
    const { modal } = openModal(makeConflictInfo({ path: 'notes/important.md' }));
    expect(findByText(modal.contentEl, 'notes/important.md')).toBe(true);
  });

  it('shows server mod time as a human-readable ISO timestamp', () => {
    const { modal } = openModal(makeConflictInfo({ serverModifiedAt: 1_700_000_000_000 }));
    expect(findByText(modal.contentEl, new Date(1_700_000_000_000).toISOString())).toBe(true);
  });

  it('shows local mod time as a human-readable ISO timestamp', () => {
    const { modal } = openModal(makeConflictInfo(), 1_700_000_050_000);
    expect(findByText(modal.contentEl, new Date(1_700_000_050_000).toISOString())).toBe(true);
  });

  it('renders all four action buttons (Keep Local, Take Server, Keep Both, Skip)', () => {
    openModal();
    const labels = allButtons().map((b) => b.label);
    expect(labels).toEqual(expect.arrayContaining(['Keep Local', 'Take Server', 'Keep Both', 'Skip']));
  });

  it('renders an apply-to-all toggle, defaulted off', () => {
    openModal();
    const toggle = lastSettings().flatMap((s) => s.toggleHandlers)[0];
    expect(toggle).toBeDefined();
    expect(toggle.value).toBe(false);
  });
});

// ── Actions ────────────────────────────────────────
describe('ConflictModal — actions', () => {
  it('Keep Local resolves with { resolution: "keep-local", applyToAll: false } and closes modal', () => {
    const { modal, choices } = openModal();
    clickButton('Keep Local');
    expect(choices).toEqual([{ resolution: 'keep-local', applyToAll: false }]);
    expect(modal.close).toHaveBeenCalledOnce();
  });

  it('Take Server resolves with keep-server', () => {
    const { modal, choices } = openModal();
    clickButton('Take Server');
    expect(choices).toEqual([{ resolution: 'keep-server', applyToAll: false }]);
    expect(modal.close).toHaveBeenCalledOnce();
  });

  it('Keep Both resolves with keep-both', () => {
    const { modal, choices } = openModal();
    clickButton('Keep Both');
    expect(choices).toEqual([{ resolution: 'keep-both', applyToAll: false }]);
    expect(modal.close).toHaveBeenCalledOnce();
  });

  it('Skip resolves with keep-local (safe default — preserves local copy untouched)', () => {
    const { modal, choices } = openModal();
    clickButton('Skip');
    expect(choices).toEqual([{ resolution: 'keep-local', applyToAll: false }]);
    expect(modal.close).toHaveBeenCalledOnce();
  });
});

// ── Apply-to-all batch behavior ────────────────────
describe('ConflictModal — apply to all', () => {
  it('toggling apply-to-all on then clicking Take Server returns applyToAll=true', () => {
    const { choices } = openModal();
    setApplyToAll(true);
    clickButton('Take Server');
    expect(choices).toEqual([{ resolution: 'keep-server', applyToAll: true }]);
  });

  it('toggling apply-to-all on then clicking Keep Local returns applyToAll=true', () => {
    const { choices } = openModal();
    setApplyToAll(true);
    clickButton('Keep Local');
    expect(choices).toEqual([{ resolution: 'keep-local', applyToAll: true }]);
  });

  it('Skip ignores apply-to-all (deferral is per-file by definition)', () => {
    const { choices } = openModal();
    setApplyToAll(true);
    clickButton('Skip');
    expect(choices).toEqual([{ resolution: 'keep-local', applyToAll: false }]);
  });
});
