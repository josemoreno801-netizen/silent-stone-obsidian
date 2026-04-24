import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock `obsidian` ────────────────────────────────
// vitest runs in a `node` environment (see vitest.config.ts) — there is no
// jsdom. We hand-roll the minimum DOM surface the SetupModal touches:
// element tree with `createEl`, `empty`, `setText`, `style`, `classList`,
// `textContent` — plus a `Modal` base class and a chainable `Setting` class
// that captures its text/toggle/button handlers so tests can drive them.
//
// Obsidian mocks are hoisted via vi.hoisted so vi.mock's factory can see
// them without the usual module-scope/hoist mismatch.
const {
  MockModal,
  MockSetting,
  MockNotice,
  createFakeEl,
  lastSettingHandlers,
} = vi.hoisted(() => {
  type Handlers = {
    textHandlers: Array<{
      onChange?: (v: string) => void;
      inputEl: FakeInputEl;
      setValueCalls: string[];
    }>;
    toggleHandlers: Array<{
      onChange?: (v: boolean) => void;
      setValueCalls: boolean[];
    }>;
    buttonHandlers: Array<{
      onClick?: () => void | Promise<void>;
      buttonEl: FakeButtonEl;
      setButtonTextCalls: string[];
    }>;
  };

  type FakeInputEl = {
    type: string;
    value: string;
    focus: () => void;
    addEventListener: (evt: string, cb: (e: { key: string; preventDefault: () => void }) => void) => void;
    __listeners: Record<string, Array<(e: { key: string; preventDefault: () => void }) => void>>;
  };

  type FakeButtonEl = {
    disabled: boolean;
    textContent: string;
  };

  type FakeEl = {
    tagName: string;
    textContent: string;
    children: FakeEl[];
    cls: string[];
    classList: { add: (c: string) => void; contains: (c: string) => boolean };
    style: Record<string, string>;
    attrs: Record<string, string>;
    createEl: (tag: string, opts?: { text?: string; cls?: string; attr?: Record<string, string> }) => FakeEl;
    setText: (t: string) => void;
    empty: () => void;
  };

  const allSettings: Handlers[] = [];

  function createFakeEl(tag: string): FakeEl {
    const el: FakeEl = {
      tagName: tag.toUpperCase(),
      textContent: '',
      children: [],
      cls: [],
      classList: {
        add: (c: string) => {
          if (!el.cls.includes(c)) el.cls.push(c);
        },
        contains: (c: string) => el.cls.includes(c),
      },
      style: {},
      attrs: {},
      createEl: (t, opts) => {
        const child = createFakeEl(t);
        if (opts?.text) child.textContent = opts.text;
        if (opts?.cls) {
          for (const c of opts.cls.split(/\s+/)) child.classList.add(c);
        }
        if (opts?.attr) {
          for (const [k, v] of Object.entries(opts.attr)) child.attrs[k] = v;
          if (opts.attr.style) {
            for (const part of opts.attr.style.split(';')) {
              const [k, v] = part.split(':').map((s) => s.trim());
              if (k) child.style[k] = v ?? '';
            }
          }
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
    close: () => void;

    constructor(app: unknown) {
      this.app = app;
      this.contentEl = createFakeEl('div');
      this.close = vi.fn(() => {
        // mimic Obsidian: onClose hook runs then contentEl is emptied
        // we let the test drive onClose explicitly via .open() lifecycle
        (this as unknown as { onClose?: () => void }).onClose?.();
      });
    }

    open(): void {
      (this as unknown as { onOpen?: () => void }).onOpen?.();
    }
  }

  class MockSetting {
    private handlers: Handlers;

    constructor(_parent: unknown) {
      this.handlers = { textHandlers: [], toggleHandlers: [], buttonHandlers: [] };
      allSettings.push(this.handlers);
    }

    setName(_name: string): this {
      return this;
    }

     
    addText(cb: (t: any) => void): this {
      const inputEl: FakeInputEl = {
        type: 'text',
        value: '',
        __listeners: {},
        focus: vi.fn(),
        addEventListener: (evt, fn) => {
          inputEl.__listeners[evt] ||= [];
          inputEl.__listeners[evt].push(fn);
        },
      };
      const captured: Handlers['textHandlers'][number] = {
        inputEl,
        setValueCalls: [],
      };
      const api = {
        setPlaceholder: (_p: string) => api,
        onChange: (fn: (v: string) => void) => {
          captured.onChange = fn;
          return api;
        },
        setValue: (v: string) => {
          captured.setValueCalls.push(v);
          inputEl.value = v;
          return api;
        },
        inputEl,
      };
      cb(api);
      this.handlers.textHandlers.push(captured);
      return this;
    }

     
    addToggle(cb: (t: any) => void): this {
      const captured: Handlers['toggleHandlers'][number] = {
        setValueCalls: [],
      };
      const api = {
        setValue: (v: boolean) => {
          captured.setValueCalls.push(v);
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

     
    addButton(cb: (b: any) => void): this {
      const buttonEl: FakeButtonEl = { disabled: false, textContent: '' };
      const captured: Handlers['buttonHandlers'][number] = {
        buttonEl,
        setButtonTextCalls: [],
      };
      const api = {
        setButtonText: (t: string) => {
          captured.setButtonTextCalls.push(t);
          buttonEl.textContent = t;
          return api;
        },
        setCta: () => api,
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

  const MockNotice = vi.fn();

  return {
    MockModal,
    MockSetting,
    MockNotice,
    createFakeEl,
    lastSettingHandlers,
  };
});

vi.mock('obsidian', () => ({
  App: class {},
  Modal: MockModal,
  Setting: MockSetting,
  Notice: MockNotice,
}));

import { SetupModal } from '../setup-modal';
import type { PendingSetup } from '../../main';

// ── Test helpers ───────────────────────────────────
type FakePlugin = {
  app: unknown;
  settings: { serverUrl: string; nickname: string };
  generateVaultMaterial: ReturnType<typeof vi.fn>;
  commitVaultSetup: ReturnType<typeof vi.fn>;
};

const SAMPLE_PHRASE =
  'abandon ability able about above absent absorb abstract absurd abuse access accident';

function makePendingSetup(): PendingSetup {
  return {
    vaultClient: {} as PendingSetup['vaultClient'],
    masterKey: new Uint8Array(32),
    wrapped: {
      encryptedMasterKey: 'ZW5j',
      salt: 'c2FsdA==',
      argon2Params: { memory: 65_536, time: 3, parallelism: 4 },
    },
  };
}

function makeFakePlugin(overrides: Partial<FakePlugin> = {}): FakePlugin {
  return {
    app: {},
    settings: {
      serverUrl: 'https://dev.silentstone.one',
      nickname: 'tester',
    },
    generateVaultMaterial: vi.fn().mockResolvedValue({
      recoveryPhrase: SAMPLE_PHRASE,
      pendingSetup: makePendingSetup(),
    }),
    commitVaultSetup: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
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

/** Drive an input: push value through onChange and store on inputEl. */
function typeInto(handler: {
  onChange?: (v: string) => void;
  inputEl: { value: string };
}, value: string): void {
  handler.inputEl.value = value;
  handler.onChange?.(value);
}

function clickButton(handler: {
  onClick?: () => void | Promise<void>;
}): void | Promise<void> {
  return handler.onClick?.();
}

function flipToggle(
  handler: { onChange?: (v: boolean) => void },
  value: boolean,
): void {
  handler.onChange?.(value);
}

/**
 * Open the modal and advance it all the way to step 2 by typing valid
 * matching passwords and clicking Continue.
 */
async function advanceToStep2(
  modal: SetupModal,
  plugin: FakePlugin,
  password = 'password1234',
): Promise<void> {
  modal.open();
  // Step 1: two text inputs + one button. Find the last Setting group
  // added in this render.
  const settings = lastSettingHandlers();
  const step1Settings = settings.slice(-3); // password, confirm, continue
  const [pw, confirm, continueBtn] = step1Settings;
  typeInto(pw.textHandlers[0], password);
  typeInto(confirm.textHandlers[0], password);
  await clickButton(continueBtn.buttonHandlers[0]);
  // onward — let microtasks resolve
  await Promise.resolve();
  await Promise.resolve();
  expect(plugin.generateVaultMaterial).toHaveBeenCalled();
}

beforeEach(() => {
  // Reset the handlers array between tests. vi.hoisted values persist
  // across tests in the file, so we wipe the collector. The array is
  // held inside the closure — clear by assigning to length.
  lastSettingHandlers().length = 0;
  MockNotice.mockReset();
  // Fresh, empty clipboard mock — setup-modal calls navigator.clipboard.writeText
  // when users click "Copy to clipboard". We never click it in these tests,
  // but mock defensively in case it's invoked.
  vi.stubGlobal('navigator', {
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
  // Node has no `window`. The modal calls `window.setTimeout` /
  // `window.clearTimeout` inside renderStep3 + onClose. Aliasing `window`
  // to `globalThis` lets vi.useFakeTimers() (which patches global
  // setTimeout/clearTimeout) intercept those calls too.
  vi.stubGlobal('window', globalThis);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ── Step 1: password ───────────────────────────────
describe('SetupModal', () => {
  describe('step 1: password', () => {
    it('renders the server-not-configured warning when settings are missing', () => {
      const plugin = makeFakePlugin({
        settings: { serverUrl: '', nickname: '' },
      });
      const modal = new SetupModal(plugin.app as never, plugin as never);
      modal.open();

      expect(
        findByText(modal.contentEl, 'Server URL and nickname must be set in Settings first.'),
      ).toBe(true);
      expect(plugin.generateVaultMaterial).not.toHaveBeenCalled();
    });

    it('shows inline error when passwords do not match', async () => {
      const plugin = makeFakePlugin();
      const modal = new SetupModal(plugin.app as never, plugin as never);
      modal.open();

      const settings = lastSettingHandlers();
      const [pw, confirm, continueBtn] = settings.slice(-3);
      typeInto(pw.textHandlers[0], 'password1234');
      typeInto(confirm.textHandlers[0], 'different5678');
      await clickButton(continueBtn.buttonHandlers[0]);

      expect(findByText(modal.contentEl, 'Passwords do not match.')).toBe(true);
      expect(plugin.generateVaultMaterial).not.toHaveBeenCalled();
    });

    it('shows inline error when password is shorter than 12 characters', async () => {
      const plugin = makeFakePlugin();
      const modal = new SetupModal(plugin.app as never, plugin as never);
      modal.open();

      const settings = lastSettingHandlers();
      const [pw, confirm, continueBtn] = settings.slice(-3);
      typeInto(pw.textHandlers[0], 'short');
      typeInto(confirm.textHandlers[0], 'short');
      await clickButton(continueBtn.buttonHandlers[0]);

      expect(
        findByText(modal.contentEl, 'Password must be at least 12 characters.'),
      ).toBe(true);
      expect(plugin.generateVaultMaterial).not.toHaveBeenCalled();
    });

    it('shows inline error when password is empty', async () => {
      const plugin = makeFakePlugin();
      const modal = new SetupModal(plugin.app as never, plugin as never);
      modal.open();

      const settings = lastSettingHandlers();
      const [, , continueBtn] = settings.slice(-3);
      await clickButton(continueBtn.buttonHandlers[0]);

      expect(
        findByText(modal.contentEl, 'Both password fields are required.'),
      ).toBe(true);
      expect(plugin.generateVaultMaterial).not.toHaveBeenCalled();
    });

    it('advances to step 2 on valid passwords and calls generateVaultMaterial', async () => {
      const plugin = makeFakePlugin();
      const modal = new SetupModal(plugin.app as never, plugin as never);
      await advanceToStep2(modal, plugin, 'password1234');

      expect(plugin.generateVaultMaterial).toHaveBeenCalledTimes(1);
      expect(plugin.generateVaultMaterial).toHaveBeenCalledWith('password1234');
      expect(findByText(modal.contentEl, 'Save your recovery phrase')).toBe(true);
    });

    it('surfaces a friendly error when generateVaultMaterial throws due to 409', async () => {
      const plugin = makeFakePlugin({
        generateVaultMaterial: vi
          .fn()
          .mockRejectedValue(
            new Error('Vault already initialized for this nickname. Use Unlock instead.'),
          ),
      });
      const modal = new SetupModal(plugin.app as never, plugin as never);
      modal.open();

      const settings = lastSettingHandlers();
      const [pw, confirm, continueBtn] = settings.slice(-3);
      typeInto(pw.textHandlers[0], 'password1234');
      typeInto(confirm.textHandlers[0], 'password1234');
      await clickButton(continueBtn.buttonHandlers[0]);

      expect(
        findByText(
          modal.contentEl,
          'Vault already initialized for this nickname. Use Unlock instead.',
        ),
      ).toBe(true);
      // Still on step 1 — step-2 heading must NOT appear.
      expect(findByText(modal.contentEl, 'Save your recovery phrase')).toBe(false);
    });

    it('surfaces a friendly error on 401-equivalent failure', async () => {
      const plugin = makeFakePlugin({
        generateVaultMaterial: vi.fn().mockRejectedValue(new Error('Invalid credentials')),
      });
      const modal = new SetupModal(plugin.app as never, plugin as never);
      modal.open();

      const settings = lastSettingHandlers();
      const [pw, confirm, continueBtn] = settings.slice(-3);
      typeInto(pw.textHandlers[0], 'password1234');
      typeInto(confirm.textHandlers[0], 'password1234');
      await clickButton(continueBtn.buttonHandlers[0]);

      // Message widened to hint at the likely cause (nickname/password mismatch)
      // and to distinguish from rate-limit / pending-approval outcomes.
      expect(
        findByText(
          modal.contentEl,
          'Server rejected your credentials. Check the nickname (case-sensitive) and password in plugin settings match your Silent Stone account exactly.',
        ),
      ).toBe(true);
    });

    it('surfaces rate-limit error distinctly from bad credentials', async () => {
      const plugin = makeFakePlugin({
        generateVaultMaterial: vi.fn().mockRejectedValue(
          new Error('Too many requests. Try again later.'),
        ),
      });
      const modal = new SetupModal(plugin.app as never, plugin as never);
      modal.open();

      const settings = lastSettingHandlers();
      const [pw, confirm, continueBtn] = settings.slice(-3);
      typeInto(pw.textHandlers[0], 'password1234');
      typeInto(confirm.textHandlers[0], 'password1234');
      await clickButton(continueBtn.buttonHandlers[0]);

      expect(
        findByText(modal.contentEl, 'Too many attempts. Wait a few minutes and try again.'),
      ).toBe(true);
    });
  });

  // ── Step 2: recovery phrase ───────────────────────
  describe('step 2: recovery phrase', () => {
    it('renders all 12 recovery words', async () => {
      const plugin = makeFakePlugin();
      const modal = new SetupModal(plugin.app as never, plugin as never);
      await advanceToStep2(modal, plugin);

      const expectedWords = SAMPLE_PHRASE.split(/\s+/);
      expect(expectedWords.length).toBe(12);
      for (let i = 0; i < expectedWords.length; i++) {
        expect(findByText(modal.contentEl, `${i + 1}. ${expectedWords[i]}`)).toBe(
          true,
        );
      }
    });

    it('disables Create Vault button until the confirmation toggle is on', async () => {
      const plugin = makeFakePlugin();
      const modal = new SetupModal(plugin.app as never, plugin as never);
      await advanceToStep2(modal, plugin);

      // Step 2 renders: 1 copy btn, 1 toggle, 1 back btn, 1 create btn
      const all = lastSettingHandlers();
      // find the create button by its button text "Create vault"
      let createBtn: { buttonEl: { disabled: boolean } } | undefined;
      let toggle: { onChange?: (v: boolean) => void } | undefined;
      for (const s of all) {
        for (const b of s.buttonHandlers) {
          if (b.setButtonTextCalls.includes('Create vault')) createBtn = b;
        }
        if (s.toggleHandlers.length) toggle = s.toggleHandlers[0];
      }
      expect(createBtn).toBeDefined();
      expect(toggle).toBeDefined();
      expect(createBtn!.buttonEl.disabled).toBe(true);

      flipToggle(toggle!, true);
      expect(createBtn!.buttonEl.disabled).toBe(false);
    });

    it('does not call commitVaultSetup while checkbox is unchecked', async () => {
      const plugin = makeFakePlugin();
      const modal = new SetupModal(plugin.app as never, plugin as never);
      await advanceToStep2(modal, plugin);

      const all = lastSettingHandlers();
      let createBtn: { onClick?: () => void | Promise<void> } | undefined;
      for (const s of all) {
        for (const b of s.buttonHandlers) {
          if (b.setButtonTextCalls.includes('Create vault')) createBtn = b;
        }
      }
      await clickButton(createBtn!);
      expect(plugin.commitVaultSetup).not.toHaveBeenCalled();
    });

    it('calls commitVaultSetup with the pendingSetup after checkbox + click', async () => {
      const pending = makePendingSetup();
      const plugin = makeFakePlugin({
        generateVaultMaterial: vi.fn().mockResolvedValue({
          recoveryPhrase: SAMPLE_PHRASE,
          pendingSetup: pending,
        }),
      });
      const modal = new SetupModal(plugin.app as never, plugin as never);
      await advanceToStep2(modal, plugin);

      const all = lastSettingHandlers();
      let createBtn: { onClick?: () => void | Promise<void> } | undefined;
      let toggle: { onChange?: (v: boolean) => void } | undefined;
      for (const s of all) {
        for (const b of s.buttonHandlers) {
          if (b.setButtonTextCalls.includes('Create vault')) createBtn = b;
        }
        if (s.toggleHandlers.length) toggle = s.toggleHandlers[0];
      }

      flipToggle(toggle!, true);
      await clickButton(createBtn!);
      await Promise.resolve();

      expect(plugin.commitVaultSetup).toHaveBeenCalledTimes(1);
      expect(plugin.commitVaultSetup).toHaveBeenCalledWith(pending);
    });

    it('maps a 409 from commitVaultSetup to the friendly "already initialized" error', async () => {
      const plugin = makeFakePlugin({
        commitVaultSetup: vi
          .fn()
          .mockRejectedValue(
            new Error('HTTP 409: Vault keys already configured. Use PUT to update.'),
          ),
      });
      const modal = new SetupModal(plugin.app as never, plugin as never);
      await advanceToStep2(modal, plugin);

      const all = lastSettingHandlers();
      let createBtn: { onClick?: () => void | Promise<void> } | undefined;
      let toggle: { onChange?: (v: boolean) => void } | undefined;
      for (const s of all) {
        for (const b of s.buttonHandlers) {
          if (b.setButtonTextCalls.includes('Create vault')) createBtn = b;
        }
        if (s.toggleHandlers.length) toggle = s.toggleHandlers[0];
      }

      flipToggle(toggle!, true);
      await clickButton(createBtn!);
      await Promise.resolve();
      await Promise.resolve();

      expect(
        findByText(
          modal.contentEl,
          'Vault already initialized for this nickname. Use Unlock instead.',
        ),
      ).toBe(true);
      // Still on step 2 — step-3 heading must NOT appear.
      expect(findByText(modal.contentEl, 'Vault created')).toBe(false);
    });

    it('advances to step 3 on successful commit', async () => {
      const plugin = makeFakePlugin();
      const modal = new SetupModal(plugin.app as never, plugin as never);
      await advanceToStep2(modal, plugin);

      const all = lastSettingHandlers();
      let createBtn: { onClick?: () => void | Promise<void> } | undefined;
      let toggle: { onChange?: (v: boolean) => void } | undefined;
      for (const s of all) {
        for (const b of s.buttonHandlers) {
          if (b.setButtonTextCalls.includes('Create vault')) createBtn = b;
        }
        if (s.toggleHandlers.length) toggle = s.toggleHandlers[0];
      }

      flipToggle(toggle!, true);
      await clickButton(createBtn!);
      await Promise.resolve();
      await Promise.resolve();

      expect(findByText(modal.contentEl, 'Vault created')).toBe(true);
    });
  });

  // ── Step 3: success ───────────────────────────────
  describe('step 3: success', () => {
    it('auto-closes after the configured timeout', async () => {
      vi.useFakeTimers();
      const plugin = makeFakePlugin();
      const modal = new SetupModal(plugin.app as never, plugin as never);
      const closeSpy = vi.spyOn(modal, 'close');

      // advanceToStep2 awaits promises; we still need real microtask flushing
      // while fake timers are in play. vi.useFakeTimers() does not fake
      // Promises by default, so awaits still work.
      await advanceToStep2(modal, plugin);

      const all = lastSettingHandlers();
      let createBtn: { onClick?: () => void | Promise<void> } | undefined;
      let toggle: { onChange?: (v: boolean) => void } | undefined;
      for (const s of all) {
        for (const b of s.buttonHandlers) {
          if (b.setButtonTextCalls.includes('Create vault')) createBtn = b;
        }
        if (s.toggleHandlers.length) toggle = s.toggleHandlers[0];
      }
      flipToggle(toggle!, true);
      await clickButton(createBtn!);
      await Promise.resolve();
      await Promise.resolve();

      expect(closeSpy).not.toHaveBeenCalled();
      vi.advanceTimersByTime(3000);
      expect(closeSpy).toHaveBeenCalledTimes(1);
    });

    it('Done button closes the modal', async () => {
      const plugin = makeFakePlugin();
      const modal = new SetupModal(plugin.app as never, plugin as never);
      const closeSpy = vi.spyOn(modal, 'close');
      await advanceToStep2(modal, plugin);

      const all = lastSettingHandlers();
      let createBtn: { onClick?: () => void | Promise<void> } | undefined;
      let toggle: { onChange?: (v: boolean) => void } | undefined;
      for (const s of all) {
        for (const b of s.buttonHandlers) {
          if (b.setButtonTextCalls.includes('Create vault')) createBtn = b;
        }
        if (s.toggleHandlers.length) toggle = s.toggleHandlers[0];
      }
      flipToggle(toggle!, true);
      await clickButton(createBtn!);
      await Promise.resolve();
      await Promise.resolve();

      // Find Done button (rendered in step 3)
      let doneBtn: { onClick?: () => void | Promise<void> } | undefined;
      for (const s of lastSettingHandlers()) {
        for (const b of s.buttonHandlers) {
          if (b.setButtonTextCalls.includes('Done')) doneBtn = b;
        }
      }
      expect(doneBtn).toBeDefined();
      await clickButton(doneBtn!);
      expect(closeSpy).toHaveBeenCalled();
    });
  });

  // ── onClose hygiene ───────────────────────────────
  describe('onClose', () => {
    it('clears password fields on close', async () => {
      const plugin = makeFakePlugin();
      const modal = new SetupModal(plugin.app as never, plugin as never);
      modal.open();

      const settings = lastSettingHandlers();
      const [pw, confirm] = settings.slice(-3);
      typeInto(pw.textHandlers[0], 'password1234');
      typeInto(confirm.textHandlers[0], 'password1234');

      modal.onClose();

      // Contract: reopening renders empty inputs (setValue called with '')
      // since onClose clears internal password state before the next render.
      lastSettingHandlers().length = 0;
      modal.onOpen();
      const reopened = lastSettingHandlers();
      const [pw2, confirm2] = reopened.slice(-3);
      expect(pw2.textHandlers[0].inputEl.value).toBe('');
      expect(confirm2.textHandlers[0].inputEl.value).toBe('');
    });

    it('clears any pending auto-close timeout', async () => {
      vi.useFakeTimers();
      const plugin = makeFakePlugin();
      const modal = new SetupModal(plugin.app as never, plugin as never);
      const closeSpy = vi.spyOn(modal, 'close');
      await advanceToStep2(modal, plugin);

      const all = lastSettingHandlers();
      let createBtn: { onClick?: () => void | Promise<void> } | undefined;
      let toggle: { onChange?: (v: boolean) => void } | undefined;
      for (const s of all) {
        for (const b of s.buttonHandlers) {
          if (b.setButtonTextCalls.includes('Create vault')) createBtn = b;
        }
        if (s.toggleHandlers.length) toggle = s.toggleHandlers[0];
      }
      flipToggle(toggle!, true);
      await clickButton(createBtn!);
      await Promise.resolve();
      await Promise.resolve();

      // User closes the modal manually before the 3s auto-close fires.
      modal.close(); // triggers onClose which clears the timeout
      expect(closeSpy).toHaveBeenCalledTimes(1);

      // Fast-forward well past the auto-close window — no extra close call.
      vi.advanceTimersByTime(5000);
      expect(closeSpy).toHaveBeenCalledTimes(1);
    });
  });
});

// Silence unused-import warning in environments that tree-shake it away.
void createFakeEl;
