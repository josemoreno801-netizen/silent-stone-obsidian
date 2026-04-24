import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock `obsidian` ────────────────────────────────
// Mirrors the mock infrastructure in unlock-modal.test.ts. We hand-roll the
// minimum DOM + widget surface LoginModal touches: contentEl with createEl/
// empty, setText, style object, a chainable Setting class that captures
// addText/addButton handlers so tests can drive them.
//
// Mocks are hoisted via vi.hoisted so vi.mock's factory can reference them.
const { MockModal, MockSetting, lastSettings } = vi.hoisted(() => {
  type InputListener = (e: { key: string; preventDefault: () => void }) => void;

  type FakeInputEl = {
    type: string;
    value: string;
    focus: ReturnType<typeof vi.fn>;
    addEventListener: (evt: string, cb: InputListener) => void;
    __listeners: Record<string, InputListener[]>;
  };

  type FakeButtonEl = { disabled: boolean; textContent: string };

  type ClickListener = (e: { preventDefault: () => void }) => void;

  type FakeEl = {
    tagName: string;
    textContent: string;
    children: FakeEl[];
    cls: string[];
    style: Record<string, string>;
    attrs: Record<string, string>;
    __clickListeners: ClickListener[];
    createEl: (
      tag: string,
      opts?: { text?: string; cls?: string; attr?: Record<string, string> },
    ) => FakeEl;
    setText: (t: string) => void;
    empty: () => void;
    addEventListener: (evt: string, cb: ClickListener) => void;
  };

  type TextHandler = {
    inputEl: FakeInputEl;
    onChange?: (v: string) => void;
    placeholder?: string;
    initialValue?: string;
  };

  type ButtonHandler = {
    buttonEl: FakeButtonEl;
    onClick?: () => void | Promise<void>;
    setButtonTextCalls: string[];
  };

  type Handlers = {
    textHandlers: TextHandler[];
    buttonHandlers: ButtonHandler[];
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
      __clickListeners: [],
      createEl: (t, opts) => {
        const child = createFakeEl(t);
        if (opts?.text) child.textContent = opts.text;
        if (opts?.cls) {
          for (const c of opts.cls.split(/\s+/)) child.cls.push(c);
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
      addEventListener: (evt, cb) => {
        if (evt === 'click') el.__clickListeners.push(cb);
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
      this.handlers = { textHandlers: [], buttonHandlers: [] };
      allSettings.push(this.handlers);
    }

    setName(_name: string): this {
      return this;
    }

    setDesc(_desc: string): this {
      return this;
    }

    addText(cb: (t: unknown) => void): this {
      const inputEl: FakeInputEl = {
        type: 'text',
        value: '',
        focus: vi.fn(),
        __listeners: {},
        addEventListener: (evt, fn) => {
          inputEl.__listeners[evt] ||= [];
          inputEl.__listeners[evt].push(fn);
        },
      };
      const captured: TextHandler = { inputEl };
      const api = {
        setPlaceholder: (p: string) => {
          captured.placeholder = p;
          return api;
        },
        setValue: (v: string) => {
          captured.initialValue = v;
          inputEl.value = v;
          return api;
        },
        onChange: (fn: (v: string) => void) => {
          captured.onChange = fn;
          return api;
        },
        inputEl,
      };
      cb(api);
      this.handlers.textHandlers.push(captured);
      return this;
    }

    addButton(cb: (b: unknown) => void): this {
      const buttonEl: FakeButtonEl = { disabled: false, textContent: '' };
      const captured: ButtonHandler = { buttonEl, setButtonTextCalls: [] };
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

import { LoginModal } from '../login-modal';

// ── Test helpers ───────────────────────────────────
type FakePlugin = {
  settings: { serverUrl: string; nickname: string; vaultAuthToken: string };
  saveSettings: ReturnType<typeof vi.fn>;
  unlockVaultWithPassword: ReturnType<typeof vi.fn>;
};

function makeFakePlugin(overrides: Partial<FakePlugin['settings']> = {}): FakePlugin {
  return {
    settings: {
      serverUrl: 'https://dev.silentstone.one',
      nickname: '',
      vaultAuthToken: '',
      ...overrides,
    },
    saveSettings: vi.fn().mockResolvedValue(undefined),
    unlockVaultWithPassword: vi.fn().mockResolvedValue(undefined),
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

function openModal(plugin: FakePlugin): LoginModal {
  const modal = new LoginModal({} as never, plugin as never);
  (modal as unknown as { open: () => void }).open();
  return modal;
}

/** First text input = nickname, second = password. First button = Log in, second = Cancel. */
function findHandlers() {
  const settings = lastSettings();
  const textHandlers = settings.flatMap((s) => s.textHandlers);
  const buttonHandlers = settings.flatMap((s) => s.buttonHandlers);
  return {
    nickname: textHandlers[0],
    password: textHandlers[1],
    login: buttonHandlers[0],
    cancel: buttonHandlers[1],
  };
}

async function fillAndSubmit(
  _modal: LoginModal,
  nickname: string,
  password: string,
): Promise<void> {
  const { nickname: n, password: p, login } = findHandlers();
  if (!n || !p || !login) throw new Error('modal did not render all expected controls');

  n.inputEl.value = nickname;
  n.onChange?.(nickname);

  p.inputEl.value = password;
  p.onChange?.(password);

  await login.onClick?.();
  await Promise.resolve();
}

beforeEach(() => {
  const all = lastSettings();
  all.length = 0;
  vi.clearAllMocks();
});

// ── Render branches ─────────────────────────────────
describe('LoginModal — render', () => {
  it('renders heading, description, nickname field, password field, Log in + Cancel buttons', () => {
    const plugin = makeFakePlugin();
    const modal = openModal(plugin);

    expect(findByText(modal.contentEl, 'Sign in to Silent Stone')).toBe(true);
    expect(findByText(modal.contentEl, 'Log in to your account')).toBe(true);

    const { nickname, password, login, cancel } = findHandlers();
    expect(nickname?.placeholder).toBe('your nickname');
    expect(password?.inputEl.type).toBe('password');
    expect(login?.buttonEl.textContent).toBe('Log in');
    expect(cancel?.buttonEl.textContent).toBe('Cancel');
  });

  it('renders "Create account" link pointing to /signup', () => {
    const plugin = makeFakePlugin();
    const modal = openModal(plugin);

    expect(findByText(modal.contentEl, "Don't have an account?")).toBe(true);
    expect(findByText(modal.contentEl, 'Create one')).toBe(true);
  });

  it('pre-fills nickname from settings when present', () => {
    const plugin = makeFakePlugin({ nickname: 'daisy' });
    openModal(plugin);

    const { nickname } = findHandlers();
    expect(nickname?.initialValue).toBe('daisy');
  });

  it('leaves nickname blank when settings.nickname is empty', () => {
    const plugin = makeFakePlugin({ nickname: '' });
    openModal(plugin);

    const { nickname } = findHandlers();
    expect(nickname?.initialValue ?? '').toBe('');
  });

  it('Cancel button closes the modal without calling unlockVaultWithPassword', () => {
    const plugin = makeFakePlugin();
    const modal = openModal(plugin);

    const { cancel } = findHandlers();
    cancel?.onClick?.();

    expect(modal.close).toHaveBeenCalledOnce();
    expect(plugin.unlockVaultWithPassword).not.toHaveBeenCalled();
  });
});

// ── Validation ──────────────────────────────────────
describe('LoginModal — validation', () => {
  it('shows "Nickname required." when submitted with empty nickname', async () => {
    const plugin = makeFakePlugin();
    const modal = openModal(plugin);

    await fillAndSubmit(modal, '', 'some-password');

    expect(plugin.unlockVaultWithPassword).not.toHaveBeenCalled();
    expect(findByText(modal.contentEl, 'Nickname required.')).toBe(true);
  });

  it('shows "Password required." when submitted with empty password', async () => {
    const plugin = makeFakePlugin();
    const modal = openModal(plugin);

    await fillAndSubmit(modal, 'daisy', '');

    expect(plugin.unlockVaultWithPassword).not.toHaveBeenCalled();
    expect(findByText(modal.contentEl, 'Password required.')).toBe(true);
  });

  it('trims whitespace-only nickname and reports it as empty', async () => {
    const plugin = makeFakePlugin();
    const modal = openModal(plugin);

    await fillAndSubmit(modal, '   ', 'password');

    expect(plugin.unlockVaultWithPassword).not.toHaveBeenCalled();
    expect(findByText(modal.contentEl, 'Nickname required.')).toBe(true);
  });
});

// ── Submit behavior ─────────────────────────────────
describe('LoginModal — submit', () => {
  it('on success: persists nickname, calls unlockVaultWithPassword, closes modal', async () => {
    const plugin = makeFakePlugin();
    const modal = openModal(plugin);

    await fillAndSubmit(modal, 'daisy', 'correct-horse-battery-staple');

    expect(plugin.settings.nickname).toBe('daisy');
    expect(plugin.saveSettings).toHaveBeenCalled();
    expect(plugin.unlockVaultWithPassword).toHaveBeenCalledWith('correct-horse-battery-staple');
    expect(modal.close).toHaveBeenCalledOnce();
  });

  it('defaults serverUrl to https://silentstone.one when unset', async () => {
    const plugin = makeFakePlugin({ serverUrl: '' });
    const modal = openModal(plugin);

    await fillAndSubmit(modal, 'daisy', 'password');

    expect(plugin.settings.serverUrl).toBe('https://silentstone.one');
  });

  it('preserves custom serverUrl when already set', async () => {
    const plugin = makeFakePlugin({ serverUrl: 'https://my-selfhosted.example.com' });
    const modal = openModal(plugin);

    await fillAndSubmit(modal, 'daisy', 'password');

    expect(plugin.settings.serverUrl).toBe('https://my-selfhosted.example.com');
  });

  it('maps HTTP 401 to "Wrong nickname or password."', async () => {
    const err = new Error('Invalid credentials') as Error & { status: number };
    err.status = 401;
    const plugin = makeFakePlugin();
    plugin.unlockVaultWithPassword = vi.fn().mockRejectedValue(err);
    const modal = openModal(plugin);

    await fillAndSubmit(modal, 'daisy', 'wrong');

    expect(modal.close).not.toHaveBeenCalled();
    expect(findByText(modal.contentEl, 'Wrong nickname or password.')).toBe(true);
  });

  it('maps HTTP 403 to "Account pending approval or suspended."', async () => {
    const err = new Error('Forbidden') as Error & { status: number };
    err.status = 403;
    const plugin = makeFakePlugin();
    plugin.unlockVaultWithPassword = vi.fn().mockRejectedValue(err);
    const modal = openModal(plugin);

    await fillAndSubmit(modal, 'daisy', 'password');

    expect(findByText(modal.contentEl, 'Account pending approval or suspended.')).toBe(true);
  });

  it('maps HTTP 429 to rate-limit message', async () => {
    const err = new Error('Too many requests') as Error & { status: number };
    err.status = 429;
    const plugin = makeFakePlugin();
    plugin.unlockVaultWithPassword = vi.fn().mockRejectedValue(err);
    const modal = openModal(plugin);

    await fillAndSubmit(modal, 'daisy', 'password');

    expect(findByText(modal.contentEl, 'Too many attempts')).toBe(true);
  });

  it('maps "vault keys not set up" error to friendly first-time-setup prompt', async () => {
    const plugin = makeFakePlugin();
    plugin.unlockVaultWithPassword = vi
      .fn()
      .mockRejectedValue(new Error('Vault keys not set up on server. Run first-time setup.'));
    const modal = openModal(plugin);

    await fillAndSubmit(modal, 'daisy', 'password');

    expect(findByText(modal.contentEl, 'No vault yet')).toBe(true);
    expect(findByText(modal.contentEl, 'Vault: first-time setup')).toBe(true);
  });

  it('maps network errors to "Can\'t reach Silent Stone"', async () => {
    const plugin = makeFakePlugin();
    plugin.unlockVaultWithPassword = vi.fn().mockRejectedValue(new Error('fetch failed'));
    const modal = openModal(plugin);

    await fillAndSubmit(modal, 'daisy', 'password');

    expect(findByText(modal.contentEl, "Can't reach Silent Stone")).toBe(true);
  });

  it('wraps unknown errors with "Sign in failed: ..." prefix', async () => {
    const plugin = makeFakePlugin();
    plugin.unlockVaultWithPassword = vi.fn().mockRejectedValue(new Error('something weird'));
    const modal = openModal(plugin);

    await fillAndSubmit(modal, 'daisy', 'password');

    expect(findByText(modal.contentEl, 'Sign in failed: something weird')).toBe(true);
  });

  it('clears password field after failed login', async () => {
    const plugin = makeFakePlugin();
    plugin.unlockVaultWithPassword = vi.fn().mockRejectedValue(new Error('fetch failed'));
    const modal = openModal(plugin);

    await fillAndSubmit(modal, 'daisy', 'wrong-password');

    const { password } = findHandlers();
    expect(password?.inputEl.value).toBe('');
  });
});
