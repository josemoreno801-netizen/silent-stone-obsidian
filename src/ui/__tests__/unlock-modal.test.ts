import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock `obsidian` ────────────────────────────────
// UnlockModal extends Obsidian's Modal and uses the Setting builder. We
// hand-roll the minimum DOM + widget surface it touches: contentEl with
// createEl/empty, setText, style object, a chainable Setting class that
// captures addText/addButton handlers so tests can drive them.
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

	type FakeEl = {
		tagName: string;
		textContent: string;
		children: FakeEl[];
		cls: string[];
		style: Record<string, string>;
		attrs: Record<string, string>;
		createEl: (tag: string, opts?: { text?: string; cls?: string; attr?: Record<string, string> }) => FakeEl;
		setText: (t: string) => void;
		empty: () => void;
	};

	type TextHandler = {
		inputEl: FakeInputEl;
		onChange?: (v: string) => void;
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
				setPlaceholder: (_p: string) => api,
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

import { UnlockModal } from '../unlock-modal';

// ── Test helpers ───────────────────────────────────
type FakePlugin = {
	settings: { serverUrl: string; nickname: string };
	unlockVaultWithPassword: ReturnType<typeof vi.fn>;
};

function makeFakePlugin(overrides: Partial<FakePlugin> = {}): FakePlugin {
	return {
		settings: {
			serverUrl: 'https://dev.silentstone.one',
			nickname: 'tester',
		},
		unlockVaultWithPassword: vi.fn().mockResolvedValue(undefined),
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

function openModal(plugin: FakePlugin): UnlockModal {
	const modal = new UnlockModal({} as never, plugin as never);
	(modal as unknown as { open: () => void }).open();
	return modal;
}

/** Search across all Setting rows for the first text handler and first button. */
function findHandlers() {
	const settings = lastSettings();
	const textHandlers = settings.flatMap((s) => s.textHandlers);
	const buttonHandlers = settings.flatMap((s) => s.buttonHandlers);
	return {
		password: textHandlers[0],
		submit: buttonHandlers[0],
	};
}

async function typeAndSubmit(_modal: UnlockModal, password: string): Promise<void> {
	const { password: passwordHandler, submit } = findHandlers();
	if (!passwordHandler || !submit) {
		throw new Error('modal did not render password input + submit button');
	}

	passwordHandler.inputEl.value = password;
	passwordHandler.onChange?.(password);
	await submit.onClick?.();
	await Promise.resolve();
}

beforeEach(() => {
	// Clear collected settings between tests so lastSettings() returns the
	// ones from the current modal open, not a stale global list.
	const all = lastSettings();
	all.length = 0;
	vi.clearAllMocks();
});

// ── Render branches ─────────────────────────────────
describe('UnlockModal — render', () => {
	it('renders heading + description + password field + Unlock button when configured', () => {
		const plugin = makeFakePlugin();
		const modal = openModal(plugin);

		expect(findByText(modal.contentEl, 'Unlock Silent Stone vault')).toBe(true);
		expect(findByText(modal.contentEl, 'master key stays in memory only')).toBe(true);

		const { password, submit } = findHandlers();
		expect(password?.inputEl.type).toBe('password');
		expect(submit?.buttonEl.textContent).toBe('Unlock');
	});

	it('shows warning and skips form when serverUrl is missing', () => {
		const plugin = makeFakePlugin({
			settings: { serverUrl: '', nickname: 'tester' },
		});
		const modal = openModal(plugin);

		expect(findByText(modal.contentEl, 'Server URL and nickname must be set')).toBe(true);
		// No Setting rows rendered
		expect(lastSettings()).toHaveLength(0);
	});

	it('shows warning and skips form when nickname is missing', () => {
		const plugin = makeFakePlugin({
			settings: { serverUrl: 'https://x', nickname: '' },
		});
		const modal = openModal(plugin);

		expect(findByText(modal.contentEl, 'Server URL and nickname must be set')).toBe(true);
		expect(lastSettings()).toHaveLength(0);
	});
});

// ── Submit behavior ─────────────────────────────────
describe('UnlockModal — submit', () => {
	it('shows "Password required." error when submitted with empty password', async () => {
		const plugin = makeFakePlugin();
		const modal = openModal(plugin);

		await typeAndSubmit(modal, '');

		expect(plugin.unlockVaultWithPassword).not.toHaveBeenCalled();
		expect(findByText(modal.contentEl, 'Password required.')).toBe(true);
	});

	it('on success: calls plugin.unlockVaultWithPassword and closes modal', async () => {
		const plugin = makeFakePlugin();
		const modal = openModal(plugin);

		await typeAndSubmit(modal, 'correct-horse-battery-staple');

		expect(plugin.unlockVaultWithPassword).toHaveBeenCalledWith('correct-horse-battery-staple');
		expect(modal.close).toHaveBeenCalledOnce();
	});

	it('maps decryption errors to a friendly "Wrong password" message', async () => {
		const plugin = makeFakePlugin({
			unlockVaultWithPassword: vi
				.fn()
				.mockRejectedValue(new Error('The operation failed for an operation-specific reason')),
		});
		const modal = openModal(plugin);

		await typeAndSubmit(modal, 'wrong-password');

		expect(modal.close).not.toHaveBeenCalled();
		expect(findByText(modal.contentEl, 'Wrong password or corrupted vault keys')).toBe(true);
	});

	it('passes through "vault keys not set up" errors unchanged', async () => {
		const plugin = makeFakePlugin({
			unlockVaultWithPassword: vi
				.fn()
				.mockRejectedValue(new Error('Vault keys not set up. Run first-time setup.')),
		});
		const modal = openModal(plugin);

		await typeAndSubmit(modal, 'any-password');

		expect(findByText(modal.contentEl, 'Vault keys not set up')).toBe(true);
	});

	it('wraps unknown errors with "Unlock failed: ..." prefix', async () => {
		const plugin = makeFakePlugin({
			unlockVaultWithPassword: vi.fn().mockRejectedValue(new Error('Network offline')),
		});
		const modal = openModal(plugin);

		await typeAndSubmit(modal, 'any-password');

		expect(findByText(modal.contentEl, 'Unlock failed: Network offline')).toBe(true);
	});

	it('clears the password field after a failed unlock', async () => {
		const plugin = makeFakePlugin({
			unlockVaultWithPassword: vi.fn().mockRejectedValue(new Error('decrypt failed')),
		});
		const modal = openModal(plugin);
		const { password: passwordHandler } = findHandlers();
		if (!passwordHandler) throw new Error('no password handler');

		await typeAndSubmit(modal, 'wrong-password');

		expect(passwordHandler.inputEl.value).toBe('');
	});
});
