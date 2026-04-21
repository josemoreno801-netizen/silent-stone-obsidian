# Obsidian Plugin Developer Reference

Quick-reference for building the Silent Stone Sync Obsidian plugin. All examples are TypeScript. Source: [Obsidian Developer Docs](https://docs.obsidian.md), curated via Context7.

---

## 1. Plugin Anatomy

Every Obsidian community plugin ships three files:

```
my-plugin/
├── manifest.json   # metadata (id, name, version, minAppVersion)
├── main.js         # compiled entry point (esbuild output)
└── styles.css      # optional styles
```

### manifest.json

```json
{
  "id": "silent-stone-sync",
  "name": "Silent Stone Sync",
  "version": "0.1.0",
  "minAppVersion": "0.15.0",
  "description": "Encrypted vault sync through your private Silent Stone server.",
  "author": "josemoreno801-netizen",
  "authorUrl": "https://github.com/josemoreno801-netizen",
  "isDesktopOnly": false
}
```

**Submission validation rules** (enforced by Obsidian's release bot):

| Field | Rules |
|-------|-------|
| `id` | No "obsidian" (case-insensitive), no ending "plugin", lowercase alphanumeric + dashes/underscores only |
| `name` | No "Obsidian" (case-insensitive), no ending "Plugin", no starting "Obsi" or ending "dian" |
| `description` | No "This plugin" or "This is a plugin", no "Obsidian", must end with `.` `?` `!` or `)`, under 250 chars |

### main.ts — Plugin Lifecycle

```typescript
import { Plugin } from 'obsidian';

export default class SilentStoneSyncPlugin extends Plugin {
  async onload() {
    // Called when plugin is activated
    // Register commands, ribbon icons, settings tab, event listeners
    console.log('Silent Stone Sync loaded');
  }

  async onunload() {
    // Called when plugin is deactivated
    // Obsidian handles most cleanup automatically
    console.log('Silent Stone Sync unloaded');
  }
}
```

**Key lifecycle rules:**
- `onload()` is async — do setup here (register commands, load settings, start sync)
- `onunload()` — clean up intervals, event listeners, any custom DOM
- Obsidian automatically cleans up anything registered via `this.register*()` methods

---

## 2. Vault API Reference

The Vault API (`app.vault`) is the primary interface for file operations. **Always prefer Vault API over Adapter API** — Vault has a caching layer and serializes writes to prevent race conditions.

### File Reading

```typescript
// For display only (cached, faster)
const content = await this.app.vault.cachedRead(file);

// For modify-and-write-back (fresh read, avoids stale data)
const content = await this.app.vault.read(file);
```

**Rule of thumb:** `cachedRead()` for UI display, `read()` before modifying content.

### File Writing

```typescript
// Create a new file
const newFile = await this.app.vault.create('path/to/note.md', '# Content');

// Overwrite existing file
await this.app.vault.modify(file, 'new content');

// Atomic read-modify-write (preferred for safe modifications)
await this.app.vault.process(file, (data) => {
  return data + '\n\nAppended content';
});
```

**`process()` is the safest** — it reads and writes atomically, preventing race conditions when multiple operations touch the same file.

### File Lookup

```typescript
// Direct lookup by path (efficient — O(1))
const file = this.app.vault.getFileByPath('some/note.md');       // TFile | null
const folder = this.app.vault.getFolderByPath('some/folder');    // TFolder | null
const abstract = this.app.vault.getAbstractFileByPath('path');   // TAbstractFile | null

// Type narrowing
if (abstract instanceof TFile) { /* file */ }
if (abstract instanceof TFolder) { /* folder */ }

// List all markdown files
const allMd = this.app.vault.getMarkdownFiles(); // TFile[]
```

**Never iterate all files to find by path** — use `getFileByPath()` / `getAbstractFileByPath()` for O(1) lookup.

### File Events

```typescript
// Watch for file changes (useful for sync trigger)
this.registerEvent(
  this.app.vault.on('modify', (file) => {
    console.log('File modified:', file.path);
  })
);

this.registerEvent(
  this.app.vault.on('create', (file) => {
    console.log('File created:', file.path);
  })
);

this.registerEvent(
  this.app.vault.on('delete', (file) => {
    console.log('File deleted:', file.path);
  })
);

this.registerEvent(
  this.app.vault.on('rename', (file, oldPath) => {
    console.log('Renamed:', oldPath, '->', file.path);
  })
);
```

Events registered with `this.registerEvent()` are auto-cleaned on `onunload()`.

---

## 3. Commands & UI

### Commands

```typescript
// Simple command
this.addCommand({
  id: 'sync-now',
  name: 'Sync vault now',
  callback: () => { this.triggerSync(); },
});

// Conditional command (only available when condition is met)
this.addCommand({
  id: 'resolve-conflicts',
  name: 'Resolve sync conflicts',
  checkCallback: (checking: boolean) => {
    if (this.hasConflicts()) {
      if (!checking) { this.openConflictModal(); }
      return true;
    }
    return false;
  },
});

// Editor command (only when editor is active)
this.addCommand({
  id: 'insert-sync-status',
  name: 'Insert sync status',
  editorCallback: (editor, view) => {
    editor.replaceRange('Last synced: ' + new Date().toISOString(), editor.getCursor());
  },
});

// Command with default hotkey
this.addCommand({
  id: 'quick-sync',
  name: 'Quick sync',
  hotkeys: [{ modifiers: ['Mod', 'Shift'], key: 's' }],
  callback: () => { this.triggerSync(); },
});
```

**`Mod` key** = Ctrl on Windows/Linux, Cmd on Mac. Let users set their own hotkeys when possible.

### Ribbon Icon

```typescript
this.addRibbonIcon('cloud', 'Silent Stone Sync', () => {
  this.triggerSync();
});
```

### Status Bar

```typescript
const statusBarEl = this.addStatusBarItem();
statusBarEl.setText('SS: Synced');
// Update later:
statusBarEl.setText('SS: Syncing...');
```

### Notices (Toast Messages)

```typescript
import { Notice } from 'obsidian';
new Notice('Sync complete!');
new Notice('Sync failed: connection refused', 5000); // 5s duration
```

---

## 4. Settings

### Settings Interface + Defaults

```typescript
interface SilentStoneSyncSettings {
  serverUrl: string;
  nickname: string;
  authToken: string;
  folderId: string;
  syncInterval: number;  // minutes
  autoSync: boolean;
}

const DEFAULT_SETTINGS: SilentStoneSyncSettings = {
  serverUrl: '',
  nickname: '',
  authToken: '',
  folderId: '',
  syncInterval: 5,
  autoSync: true,
};
```

### Loading & Saving

```typescript
// In Plugin class:
settings: SilentStoneSyncSettings;

async onload() {
  await this.loadSettings();
  this.addSettingTab(new SilentStoneSyncSettingTab(this.app, this));
}

async loadSettings() {
  this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
}

async saveSettings() {
  await this.saveData(this.settings);
}
```

### Settings Tab UI

```typescript
import { App, PluginSettingTab, Setting } from 'obsidian';

class SilentStoneSyncSettingTab extends PluginSettingTab {
  plugin: SilentStoneSyncPlugin;

  constructor(app: App, plugin: SilentStoneSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // Text input
    new Setting(containerEl)
      .setName('Server URL')
      .setDesc('Your Silent Stone server address (e.g., https://silentstone.one)')
      .addText((text) =>
        text.setPlaceholder('https://...').setValue(this.plugin.settings.serverUrl)
          .onChange(async (value) => {
            this.plugin.settings.serverUrl = value;
            await this.plugin.saveSettings();
          })
      );

    // Toggle
    new Setting(containerEl)
      .setName('Auto-sync')
      .setDesc('Automatically sync on file changes')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoSync)
          .onChange(async (value) => {
            this.plugin.settings.autoSync = value;
            await this.plugin.saveSettings();
          })
      );

    // Slider
    new Setting(containerEl)
      .setName('Sync interval')
      .setDesc('Minutes between automatic syncs')
      .addSlider((slider) =>
        slider.setLimits(1, 60, 1).setValue(this.plugin.settings.syncInterval)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.syncInterval = value;
            await this.plugin.saveSettings();
          })
      );
  }
}
```

### SecretComponent (for API Tokens)

```typescript
import { SecretComponent, Setting } from 'obsidian';

new Setting(containerEl)
  .setName('Auth token')
  .setDesc('Session token from Silent Stone (stored securely)')
  .addComponent((el) =>
    new SecretComponent(this.app, el)
      .setValue(this.plugin.settings.authToken)
      .onChange((value) => {
        this.plugin.settings.authToken = value;
        this.plugin.saveSettings();
      })
  );
```

---

## 5. HTTP Requests from Plugins

Obsidian provides `requestUrl()` for network requests (works on desktop and mobile):

```typescript
import { requestUrl, RequestUrlParam } from 'obsidian';

const response = await requestUrl({
  url: `${serverUrl}/api/folders`,
  method: 'GET',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  },
});

// response.json — parsed JSON body
// response.status — HTTP status code
// response.headers — response headers
```

**Why `requestUrl()` over `fetch()`:** Obsidian's `requestUrl()` bypasses CORS restrictions and works consistently across desktop and mobile platforms.

---

## 6. Community Submission Checklist

Before submitting to the Obsidian community plugins registry:

- [ ] `manifest.json` passes all validation rules (see Section 1)
- [ ] Plugin ID, name, and description follow naming conventions
- [ ] ESLint configured with `eslint-plugin-obsidianmd` (27 rules)
- [ ] No `console.log` in production (use `Notice` for user feedback)
- [ ] All registered events use `this.registerEvent()` (auto-cleanup)
- [ ] Settings stored via `loadData()`/`saveData()` (not localStorage)
- [ ] Secrets use `SecretComponent` (not plain text settings)
- [ ] `onunload()` cleans up any non-registered resources
- [ ] Works on mobile (if `isDesktopOnly: false`)
- [ ] README.md documents installation, configuration, and usage
- [ ] `versions.json` maps plugin version to minimum Obsidian version
- [ ] No hardcoded "Obsidian" in user-facing strings

### ESLint Setup

```bash
npm install --save-dev eslint eslint-plugin-obsidianmd
```

```javascript
// eslint.config.mjs
import obsidianmd from 'eslint-plugin-obsidianmd';

export default [
  ...obsidianmd.configs.recommended,
  {
    rules: {
      'obsidianmd/ui/sentence-case': ['warn', {
        brands: ['Silent Stone', 'Syncthing'],
        acronyms: ['API', 'URL', 'SSE'],
      }],
    },
  },
];
```

---

## 7. Silent Stone API Mapping

The plugin communicates with Silent Stone's REST API. See [API_ENDPOINTS.md](./API_ENDPOINTS.md) for full reference.

### Auth (requires new Bearer token endpoint)

| Plugin Action | SS Endpoint | Notes |
|---------------|-------------|-------|
| Login | `POST /api/auth/token` | **NEW** — returns token in body (existing `/api/auth/login` uses Set-Cookie with SameSite=Strict, incompatible with `requestUrl()`) |
| Validate session | `GET /api/auth/me` | Returns `{ nickname, role }` |
| Logout | `POST /api/auth/logout` | Destroys server-side session |

### Folders (currently admin-only)

| Plugin Action | SS Endpoint | Notes |
|---------------|-------------|-------|
| List folders | `GET /api/folders` | Returns `FolderInfo[]` |
| Create vault folder | `POST /api/folders` | Body: `{ id, label, path, type: "sendreceive" }` |
| Delete folder | `DELETE /api/folders/:id` | |
| Browse files | `GET /api/folders/:id/files` | Query: `?path=subfolder` |
| Upload file | `POST /api/folders/:id/files` | Multipart form data |
| Create directory | `POST /api/folders/:id/files/mkdir` | Body: `{ path }` |
| Delete file | `POST /api/folders/:id/files/delete` | Body: `{ path }` |

### Encryption

| Plugin Action | SS Endpoint | Notes |
|---------------|-------------|-------|
| Get encryption | `GET /api/folders/:id/encryption` | Per-device password state |
| Set password | `PUT /api/folders/:id/encryption` | Body: `{ deviceID, password }` |

### Status

| Plugin Action | SS Endpoint | Notes |
|---------------|-------------|-------|
| Server health | `GET /api/health` | Public |
| Server status | `GET /api/status` | Public — Syncthing connection state |
| Real-time events | `GET /api/events` | SSE stream (admin-only) |

### Key Types (mirror from `src/lib/core/folder-types.ts`)

```typescript
interface FolderInfo {
  id: string;
  label: string;
  path: string;
  type: string;      // 'sendreceive' | 'sendonly' | 'receiveonly' | 'receiveencrypted'
  encrypted: boolean;
  browsable?: boolean;
  devices: FolderDevice[];
  status?: FolderStatus;
  errors?: FolderErrorDetail[];
}

interface FolderDevice {
  deviceID: string;
  hasEncryptionPassword: boolean;
}

interface FolderStatus {
  state: string;
  globalBytes: number;
  globalFiles: number;
  inSyncBytes: number;
  inSyncFiles: number;
  pullErrors?: number;
  error?: string;
}
```

---

## 8. Known Server Gaps for Plugin

These gaps must be addressed before the plugin is fully functional:

1. ~~**No Bearer token auth**~~ **RESOLVED (v0.2)** — `/api/vault/*` routes use `Authorization: Bearer` header with 90-day tokens issued by `POST /api/vault/token`. Middleware checks Bearer for vault routes before cookie fallthrough.
2. **Admin-only folder routes** — All `/api/folders/*` require admin role. This only affects the Syncthing (File Sync) track. The Vault track is member-accessible.
3. **Rate limiting** — File mutations limited to 10/min (`rate-limit.ts`). Vault track has its own per-endpoint limits tuned for sync (see v0.2 `vault-rate-limit.ts`).
4. **No file metadata endpoint** — Plugin diffs via the encrypted manifest (`GET /api/vault/manifest`) which returns sequence + hashes. No separate metadata endpoint needed for the vault track.
5. **SSE events are admin-only** — Plugin can't use `/api/events` for real-time sync status without admin credentials. Plugin currently polls manifest on interval.

---

## 9. Crypto Module (`obsidian-plugin/src/crypto/`)

**Status: v0.3 complete — 14 tests in `obsidian-plugin/src/crypto/__tests__/` (keys.test.ts, cipher.test.ts)**

The plugin encrypts vault data locally before upload. All crypto lives in `obsidian-plugin/src/crypto/` and is covered by Vitest unit tests in `crypto/__tests__/`.

### File Layout

```
obsidian-plugin/src/crypto/
├── types.ts        # MasterKeyMaterial, WrappedKey, RecoveryPhrase, Argon2Params
├── keys.ts         # Key generation, BIP39 recovery, Argon2id password wrapping
├── cipher.ts       # AES-256-GCM blob encrypt / decrypt
└── __tests__/      # Vitest suites (14 tests for keys.ts)
```

### Dependencies

| Package | Purpose |
|---------|---------|
| `@noble/hashes` | Argon2id, HKDF-SHA256, `randomBytes` |
| `@scure/bip39` | 12-word recovery phrase (English wordlist) |
| `crypto.subtle` (Web Crypto) | AES-GCM encrypt/decrypt (available in Obsidian runtime) |

### Key Derivation Flow

```
128-bit entropy (random)
     │
     ├──► BIP39 encode ──► 12-word recovery phrase (user-visible backup)
     │
     └──► HKDF-SHA256 ──► 256-bit master key ──► AES-GCM blob encryption
                                │
                                │ (at rest)
                                ▼
                         Wrap with KEK from
                         Argon2id(password, salt)
                                │
                                ▼
                         WrappedKey blob stored via
                         PUT /api/vault/keys
```

**Default Argon2id params** — memory 64 MB, iterations 3, parallelism 4. Tunable per-user — stored alongside the wrapped key on the server.

### Public API

```typescript
// keys.ts
export const DEFAULT_ARGON2_PARAMS: Argon2Params;

// Generate a fresh master key. Returns the 256-bit AES key + 12-word recovery phrase.
export function generateMasterKey(): Promise<MasterKeyMaterial>;

// Recover a master key from the 12-word BIP39 phrase.
export function recoverFromMnemonic(phrase: RecoveryPhrase): Promise<MasterKeyMaterial>;

// Wrap the master key for at-rest storage using a password-derived KEK.
export function wrapMasterKey(
  masterKey: Uint8Array,
  password: string,
  params?: Argon2Params,
): Promise<WrappedKey>;

// Unwrap the master key using the password. Throws on wrong password.
export function unwrapMasterKey(input: UnwrapInput): Promise<Uint8Array>;

// cipher.ts
export const NONCE_LENGTH: 12;

// Encrypt a blob. Output format: nonce(12) || ciphertext || GCM tag(16).
export function encryptBlob(plaintext: Uint8Array, key: Uint8Array): Promise<Uint8Array>;

// Decrypt a blob produced by encryptBlob. Throws on tampering / wrong key.
export function decryptBlob(ciphertext: Uint8Array, key: Uint8Array): Promise<Uint8Array>;
```

### Rules of Engagement

- **Never reuse a nonce.** `encryptBlob` generates a fresh random 12-byte nonce per call. Do not cache or reuse.
- **Keys are always 32 bytes.** Both encrypt and decrypt throw if `key.length !== 32`.
- **Never log key material.** Not `masterKey`, not `mnemonic`, not `password`. Nothing.
- **Recovery phrase is the ultimate backup.** If the user forgets their password AND loses the phrase, vault data is permanently unrecoverable. The server cannot help.
- **TS 5.7 BufferSource compat gotcha** — `@noble` returns `Uint8Array<ArrayBufferLike>`, Web Crypto needs `ArrayBuffer`. Use the internal `toBuffer()` helper in `keys.ts` / `cipher.ts` to copy into a fresh `ArrayBuffer`.
- **ESM import paths** — use `.js` extensions (`@noble/hashes/argon2.js`, not `@noble/hashes/argon2`). Vitest enforces the strict exports map.

### Upload Path Integration

When the sync engine uploads a file:

```
Vault file (Uint8Array plaintext)
     │
     ▼
encryptBlob(plaintext, masterKey)        ← crypto/cipher.ts
     │
     ▼
PUT /api/vault/blobs/:id  (Bearer token) ← api/vault-client.ts
     │
     ▼
Server writes ciphertext to disk. Never sees key or plaintext.
```

Download path reverses this: `GET /api/vault/blobs/:id` → `decryptBlob()` → write to vault.

**Related:** See `docs/OBSIDIAN_PLUGIN_ARCHITECTURE.md` for the full sync engine design and [`docs/diagrams/sequence-plugin-crypto.md`](./diagrams/sequence-plugin-crypto.md) for a sequence diagram of the encrypt/decrypt flow.

---

## 10. VaultClient API Reference (`obsidian-plugin/src/api/vault-client.ts`)

**Status: v0.3 complete — closes #83. 248 lines, typed wrapper around all `/api/vault/*` endpoints.**

`VaultClient` is the plugin's HTTP client for the zero-knowledge Vault API. It wraps Obsidian's `requestUrl()` to bypass CORS on both desktop and mobile, and handles Bearer token authentication separately from the cookie-based session auth used by the Syncthing (File Sync) track.

### Design Overview

- **Bearer token auth** — every request (except `createToken()` and `health()`) sends `Authorization: Bearer {token}`. Tokens are obtained via `POST /api/vault/token` and valid for 90 days.
- **Binary vs JSON** — manifest and blob endpoints exchange raw `ArrayBuffer`s (application/octet-stream). Token, status, keys, and batch endpoints exchange JSON.
- **CSRF gotcha** — Caddy drops bodiless POST/PUT/DELETE as 403. `VaultClient` sets `Content-Type` on **all** mutations (`application/json` for JSON, `application/octet-stream` for binary) — even a bodiless DELETE gets `Content-Type: application/json` so the reverse proxy lets it through.
- **Typed errors** — non-2xx responses from `requestUrl()` throw with a `status` field. `getManifest()` and `getKeys()` catch 404 and return `null`; all other methods let the error bubble.

### Constructor

```typescript
new VaultClient(serverUrl: string, token: string)
```

- `serverUrl` — base URL of the Silent Stone server (e.g. `https://silentstone.one`). Trailing slashes are stripped via `.replace(/\/+$/, '')`.
- `token` — Bearer token from `POST /api/vault/token`. Stored on the instance and sent on every authenticated call.

### `setToken(token: string): void`

Update the Bearer token in place after re-authentication. Useful when a token expires mid-session and a new one is minted without recreating the client.

### Token Endpoints

#### `createToken(req: VaultTokenRequest): Promise<VaultTokenResponse>`

- **Endpoint:** `POST /api/vault/token`
- **Auth:** Public (no Bearer required)
- **Content-Type:** `application/json`
- **Purpose:** Exchange `{ nickname, password, label }` for a 90-day Bearer token. Call this before any other method if no token is cached.

### Status Endpoint

#### `getStatus(): Promise<VaultStatusResponse>`

- **Endpoint:** `GET /api/vault/status`
- **Auth:** Bearer
- **Returns:** Storage usage, quota limit, tier, manifest sequence, and `last_sync_at`.

### Manifest Endpoints (binary, optimistic concurrency)

#### `getManifest(): Promise<{ data: ArrayBuffer; sequenceNumber: number } | null>`

- **Endpoint:** `GET /api/vault/manifest`
- **Auth:** Bearer
- **Returns:** The encrypted manifest as a raw `ArrayBuffer` plus the server's current sequence number (from `X-Sequence-Number` header). Returns `null` on 404 (no manifest exists yet).
- **Format:** The `ArrayBuffer` is an AES-256-GCM ciphertext produced by `crypto/cipher.ts` — structure: `nonce (12 bytes) || ciphertext || auth tag (16 bytes)`.

#### `putManifest(data: ArrayBuffer, sequenceNumber: number): Promise<ManifestPutResponse>`

- **Endpoint:** `PUT /api/vault/manifest`
- **Auth:** Bearer
- **Content-Type:** `application/octet-stream`
- **Headers:** `X-Sequence-Number: {N}` — must match the server's current value or the server returns 409 Conflict with both numbers.
- **Purpose:** Upload an updated encrypted manifest. The server increments its stored sequence on success.

### Blob Endpoints (binary CRUD)

#### `putBlob(id: string, data: ArrayBuffer): Promise<BlobUploadResponse>`

- **Endpoint:** `PUT /api/vault/blobs/{id}`
- **Auth:** Bearer
- **Content-Type:** `application/octet-stream`
- **Constraints:** `id` must be a valid UUID v4. `data` is an encrypted blob from `encryptBlob()`. Rejected with 413 if upload would exceed the user's quota.

#### `getBlob(id: string): Promise<ArrayBuffer>`

- **Endpoint:** `GET /api/vault/blobs/{id}`
- **Auth:** Bearer
- **Returns:** Raw encrypted bytes. Pass to `decryptBlob()` with the master key to recover plaintext.

#### `deleteBlob(id: string): Promise<BlobDeleteResponse>`

- **Endpoint:** `DELETE /api/vault/blobs/{id}`
- **Auth:** Bearer
- **Content-Type:** `application/json` — **required** to bypass Caddy's CSRF rejection of bodiless mutations.

### Batch Upload

#### `batchUpload(blobs: BatchBlobEntry[]): Promise<BatchUploadResponse>`

- **Endpoint:** `POST /api/vault/blobs/batch`
- **Auth:** Bearer
- **Content-Type:** `application/json`
- **Payload:** Each entry contains `{ id, data: base64string }`. Max 50 blobs per call.
- **Quota:** Atomic — the entire batch is rejected with 413 if the total size would exceed the quota. No partial writes.

### Key Management Endpoints

#### `setupKeys(params: VaultKeyParams): Promise<VaultKeySetupResponse>`

- **Endpoint:** `POST /api/vault/keys/setup`
- **Auth:** Bearer
- **Content-Type:** `application/json`
- **Purpose:** First-time registration of the encrypted master key and Argon2 parameters (from `wrapMasterKey()`). Returns 409 if keys already exist — use `updateKeys()` instead.

#### `getKeys(): Promise<VaultKeyParams | null>`

- **Endpoint:** `GET /api/vault/keys`
- **Auth:** Bearer
- **Returns:** `{ encryptedMasterKey, salt, argon2Params }` for unwrapping, or `null` on 404 (keys not yet set up).

#### `updateKeys(params: VaultKeyParams): Promise<VaultKeyUpdateResponse>`

- **Endpoint:** `PUT /api/vault/keys`
- **Auth:** Bearer
- **Content-Type:** `application/json`
- **Purpose:** Re-wrap the master key (password change or recovery phrase flow). Returns 404 if keys have not been set up — call `setupKeys()` first.

### Health Check

#### `health(): Promise<boolean>`

- **Endpoint:** `GET /api/health`
- **Auth:** Public (no Bearer required)
- **Returns:** `true` on HTTP 200, `false` on any error — reachability probe for the settings tab "Test connection" button.

### Related Code

- Response types are defined in `obsidian-plugin/src/api/vault-types.ts` (mirrored from `src/lib/vault/schemas.ts` on the server).
- The matching server handlers live under `src/lib/vault/` (see `docs/API_ENDPOINTS.md` for the full route list).
- See [`docs/diagrams/sequence-plugin-sync.md`](./diagrams/sequence-plugin-sync.md) for the end-to-end sync sequence that calls these methods.

---

## 11. Distribution & Beta Testing (BRAT)

The plugin ships to testers via **BRAT** (Beta Reviewers Auto-update Tester) before official Obsidian community plugins registry approval. BRAT pulls releases directly from this GitHub repo and auto-updates testers when we cut a new release. Same `id` (`silent-stone-sync`) means a tester's BRAT install and a future registry install share settings and synced state — the swap is seamless.

### For testers — install via BRAT

1. Install BRAT in Obsidian: **Settings → Community Plugins → Browse → search "BRAT" → Install → Enable**.
2. Open BRAT settings: **Settings → Obsidian42 — BRAT → Add Beta Plugin**.
3. Paste the repo URL: `https://github.com/josemoreno801-netizen/silent-stone`
4. Click **Add Plugin**. BRAT pulls the latest release.
5. Enable **Silent Stone Sync** in Community Plugins.
6. New releases auto-update on Obsidian start. Force a check in BRAT: **Check for updates to all beta plugins**.

### For testers — manual install (BRAT fallback)

If BRAT misbehaves or a tester prefers manual control:

1. Download `main.js`, `manifest.json`, `styles.css` from the [latest release](https://github.com/josemoreno801-netizen/silent-stone/releases) — files are at the release root, not zipped.
2. In your Obsidian vault folder, create `.obsidian/plugins/silent-stone-sync/` (the `.obsidian` folder is hidden — enable hidden files in your file manager).
3. Drop all three files into that directory.
4. In Obsidian: **Settings → Community Plugins → Reload** (refresh icon), then enable **Silent Stone Sync**.
5. Repeat steps 1–3 manually whenever you want to update — no auto-update with this method.

### Cutting a release (maintainer)

Releases are fully automated by `.github/workflows/plugin-release.yml`. The workflow fires on any tag matching `plugin-v*`, builds the plugin, and creates a GitHub Release with `main.js`, `manifest.json`, and `styles.css` attached at the release root (which is exactly what BRAT and the registry pattern-match).

```bash
cd obsidian-plugin
npm version patch       # or `minor` / `major`
                        #   - bumps package.json
                        #   - `version` lifecycle hook syncs manifest.json + versions.json
                        #   - npm commits all three files
                        #   - npm tags the commit `plugin-v<X.Y.Z>` (prefix from .npmrc)
                        #   - `postversion` hook pushes commit + tag
# Workflow runs automatically. Watch with:
gh run watch
gh release view plugin-v0.1.2 --repo josemoreno801-netizen/silent-stone
```

**If you want to dry-run** (bump locally without pushing): edit `obsidian-plugin/package.json` and temporarily remove the `postversion` script, then re-add after verifying the bump.

**If the workflow fails on the version-match check**: the tag and `manifest.json` versions don't agree. Usually means the `version` lifecycle hook didn't run. Fix `manifest.json` manually, force-push the tag (`git tag -f plugin-vX.Y.Z && git push -f origin plugin-vX.Y.Z`), and the workflow re-runs.

### Local dev — symlink build into a real vault

For day-to-day plugin development, symlink the build output into an actual Obsidian vault so changes are picked up live by `npm run dev`'s watch mode:

```bash
cd obsidian-plugin
npm install                                    # one-time
npm run install-to-vault -- /path/to/vault     # creates symlinks in <vault>/.obsidian/plugins/silent-stone-sync/
npm run dev                                    # watch mode — rebuilds main.js on every save
# In Obsidian: Cmd/Ctrl+R reloads the app and picks up the rebuilt code
```

Re-running `install-to-vault` is idempotent (replaces existing symlinks). The script aborts if the target isn't a real Obsidian vault (no `.obsidian/` directory).

### Why BRAT instead of waiting for the registry?

Per the v0.5 plan in `docs/business-visual.html`: registry submission review can take weeks to months. Beta testers can use BRAT today with a paste-the-URL install. When v1.0 ships and we submit to the official registry (issues #96 and #97), BRAT users seamlessly migrate by uninstalling the BRAT version and installing the registry version — same plugin `id`, same settings.
