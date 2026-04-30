import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock `obsidian` ────────────────────────────────
// vitest runs in node (no jsdom). We hand-roll the minimum DOM surface the
// LogoutModal touches: createEl/empty for content tree, a chainable Setting
// that captures button handlers, and a Modal base whose close() invokes the
// subclass's onClose hook so the cleanup contract is testable.
const {
  MockModal,
  MockSetting,
  MockNotice,
  lastSettingHandlers,
  resetHandlers,
} = vi.hoisted(() => {
  type FakeButtonEl = {
    disabled: boolean;
    textContent: string;
  };

  type ButtonHandler = {
    onClick?: () => void | Promise<void>;
    buttonEl: FakeButtonEl;
    setButtonTextCalls: string[];
    setWarningCalls: number;
  };

  type Handlers = {
    buttonHandlers: ButtonHandler[];
  };

  type FakeEl = {
    tagName: string;
    textContent: string;
    children: FakeEl[];
    cls: string[];
    createEl: (
      tag: string,
      opts?: { text?: string; cls?: string },
    ) => FakeEl;
    empty: () => void;
  };

  const allSettings: Handlers[] = [];

  function createFakeEl(tag: string): FakeEl {
    const el: FakeEl = {
      tagName: tag.toUpperCase(),
      textContent: '',
      children: [],
      cls: [],
      createEl: (t, opts) => {
        const child = createFakeEl(t);
        if (opts?.text) child.textContent = opts.text;
        if (opts?.cls) child.cls.push(...opts.cls.split(/\s+/));
        el.children.push(child);
        return child;
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
    close: () => void;

    constructor(app: unknown) {
      this.app = app;
      this.contentEl = createFakeEl('div');
      this.close = vi.fn(() => {
        (this as unknown as { onClose?: () => void }).onClose?.();
      });
    }

    open(): void {
      (this as unknown as { onOpen?: () => void }).onOpen?.();
    }
  }

  type ButtonApi = {
    setButtonText: (t: string) => ButtonApi;
    setWarning: () => ButtonApi;
    setCta: () => ButtonApi;
    setTooltip: (t: string) => ButtonApi;
    onClick: (fn: () => void | Promise<void>) => ButtonApi;
    buttonEl: FakeButtonEl;
  };

  class MockSetting {
    private handlers: Handlers;

    constructor(_parent: unknown) {
      this.handlers = { buttonHandlers: [] };
      allSettings.push(this.handlers);
    }

    setName(_name: string): this {
      return this;
    }

    setDesc(_desc: string): this {
      return this;
    }

    addButton(cb: (b: ButtonApi) => void): this {
      const buttonEl: FakeButtonEl = { disabled: false, textContent: '' };
      const captured: ButtonHandler = {
        buttonEl,
        setButtonTextCalls: [],
        setWarningCalls: 0,
      };
      const api: ButtonApi = {
        setButtonText: (t: string) => {
          captured.setButtonTextCalls.push(t);
          buttonEl.textContent = t;
          return api;
        },
        setWarning: () => {
          captured.setWarningCalls += 1;
          return api;
        },
        setCta: () => api,
        setTooltip: (_t: string) => api,
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
  }

  function lastSettingHandlers(): Handlers[] {
    return allSettings;
  }

  function resetHandlers(): void {
    allSettings.length = 0;
  }

  const MockNotice = vi.fn();

  return {
    MockModal,
    MockSetting,
    MockNotice,
    lastSettingHandlers,
    resetHandlers,
  };
});

vi.mock('obsidian', () => ({
  App: class {},
  Modal: MockModal,
  Setting: MockSetting,
  Notice: MockNotice,
}));

import { LogoutModal } from '../logout-modal';

// ── Test helpers ───────────────────────────────────
type FakePlugin = {
  app: unknown;
  logoutVault: ReturnType<typeof vi.fn>;
};

function makeFakePlugin(overrides: Partial<FakePlugin> = {}): FakePlugin {
  return {
    app: {},
    logoutVault: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

type TreeNode = { textContent: string; children: TreeNode[] };

function findByText(node: TreeNode, needle: string): boolean {
  if ((node.textContent ?? '').includes(needle)) return true;
  for (const c of node.children ?? []) {
    if (findByText(c, needle)) return true;
  }
  return false;
}

function findButton(label: string): {
  onClick?: () => void | Promise<void>;
  buttonEl: { disabled: boolean; textContent: string };
  setWarningCalls: number;
} | undefined {
  for (const s of lastSettingHandlers()) {
    for (const b of s.buttonHandlers) {
      if (b.setButtonTextCalls.includes(label)) return b;
    }
  }
  return undefined;
}

beforeEach(() => {
  resetHandlers();
  MockNotice.mockReset();
});

describe('LogoutModal', () => {
  it('renders title + copy explaining what logout does and does not affect', () => {
    const plugin = makeFakePlugin();
    const modal = new LogoutModal(plugin.app as never, plugin as never);
    modal.open();

    const root = modal.contentEl as unknown as TreeNode;
    expect(findByText(root, 'Log out of Silent Stone')).toBe(true);
    expect(findByText(root, 'connection token')).toBe(true);
    // Reassures the user that logout doesn't wipe their notes — important
    // because the action is destructive-adjacent and the warning styling
    // could otherwise read as "delete vault."
    expect(findByText(root, 'local notes are not affected')).toBe(true);
  });

  it('Log out button is rendered with warning styling', () => {
    const plugin = makeFakePlugin();
    const modal = new LogoutModal(plugin.app as never, plugin as never);
    modal.open();

    const logoutBtn = findButton('Log out');
    expect(logoutBtn).toBeDefined();
    expect(logoutBtn!.setWarningCalls).toBe(1);
  });

  it('Cancel closes the modal without calling logoutVault', async () => {
    const plugin = makeFakePlugin();
    const modal = new LogoutModal(plugin.app as never, plugin as never);
    const closeSpy = vi.spyOn(modal, 'close');
    modal.open();

    const cancelBtn = findButton('Cancel');
    expect(cancelBtn).toBeDefined();
    await cancelBtn?.onClick?.();

    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(plugin.logoutVault).not.toHaveBeenCalled();
  });

  it('Log out invokes plugin.logoutVault and closes the modal', async () => {
    const plugin = makeFakePlugin();
    const modal = new LogoutModal(plugin.app as never, plugin as never);
    const closeSpy = vi.spyOn(modal, 'close');
    modal.open();

    const logoutBtn = findButton('Log out');
    expect(logoutBtn).toBeDefined();
    logoutBtn?.onClick?.();
    // Drain the microtask queue: submit() awaits logoutVault, then close.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(plugin.logoutVault).toHaveBeenCalledTimes(1);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('disables the Log out button while the logout request is in flight', async () => {
    let resolveLogout!: () => void;
    const inflight = new Promise<void>((resolve) => {
      resolveLogout = resolve;
    });
    const plugin = makeFakePlugin({
      logoutVault: vi.fn().mockReturnValue(inflight),
    });
    const modal = new LogoutModal(plugin.app as never, plugin as never);
    modal.open();

    const logoutBtn = findButton('Log out');
    expect(logoutBtn).toBeDefined();

    // Fire — submit() runs synchronously up to its first await, which is
    // where it sets the disabled flag and the spinner copy.
    logoutBtn?.onClick?.();
    expect(logoutBtn!.buttonEl.disabled).toBe(true);
    expect(logoutBtn!.buttonEl.textContent).toBe('Logging out…');

    // Resolve and let the finally block reset state.
    resolveLogout();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(plugin.logoutVault).toHaveBeenCalledTimes(1);
    expect(logoutBtn!.buttonEl.disabled).toBe(false);
    expect(logoutBtn!.buttonEl.textContent).toBe('Log out');
  });

  it('rejects double-submission while a logout is in flight', async () => {
    let resolveLogout!: () => void;
    const inflight = new Promise<void>((resolve) => {
      resolveLogout = resolve;
    });
    const plugin = makeFakePlugin({
      logoutVault: vi.fn().mockReturnValue(inflight),
    });
    const modal = new LogoutModal(plugin.app as never, plugin as never);
    modal.open();

    const logoutBtn = findButton('Log out');
    expect(logoutBtn).toBeDefined();

    logoutBtn?.onClick?.();
    logoutBtn?.onClick?.();
    logoutBtn?.onClick?.();

    resolveLogout();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // All extra clicks short-circuit on `if (this.submitting) return;`
    expect(plugin.logoutVault).toHaveBeenCalledTimes(1);
  });

  it('onClose empties contentEl', () => {
    const plugin = makeFakePlugin();
    const modal = new LogoutModal(plugin.app as never, plugin as never);
    modal.open();
    expect(modal.contentEl.children.length).toBeGreaterThan(0);

    modal.onClose();
    expect(modal.contentEl.children.length).toBe(0);
  });
});
