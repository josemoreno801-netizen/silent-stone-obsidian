# Obsidian Plugin Architecture

System design for the Silent Stone Sync Obsidian community plugin.

## Overview

The plugin lets users sync their Obsidian vault through their private Silent Stone server with **end-to-end encryption**. All vault data is encrypted on the user's device before upload using AES-256-GCM — the server stores only encrypted blobs (zero-knowledge). The plugin talks directly to Silent Stone's Vault REST API using Bearer token auth.

```
┌─────────────────────┐     HTTPS / REST      ┌──────────────────┐
│  OBSIDIAN           │ ──────────────────────►│  SILENT STONE    │
│                     │  Bearer token auth     │  SERVER (VPS)    │
│  Plugin encrypts    │                        │                  │
│  vault files locally│  Encrypted blobs only  │  Stores encrypted│
│  before upload      │◄──────────────────────│  blobs on disk   │
│                     │                        │  (zero-knowledge)│
│  Decrypts after     │                        │                  │
│  download           │                        │                  │
└─────────────────────┘                        └──────────────────┘
```

**Key insight:** Users who pay $1/month get seamless E2E encrypted sync from inside Obsidian. The server never sees plaintext — even the server admin cannot read vault contents. Recovery is possible only with the user's password or their 12-word recovery phrase.

See: [component-plugin-overview.md](./diagrams/component-plugin-overview.md) (Mermaid diagram)

---

## Auth Flow

Silent Stone uses session-based auth with `HttpOnly` cookies (`SameSite=Strict`). This doesn't work for the plugin because:

1. Obsidian's `requestUrl()` is not a browser — no cookie jar
2. `SameSite=Strict` blocks cross-origin cookie transmission
3. The login endpoint deliberately never returns the token in the response body

**Solution:** New `/api/auth/token` endpoint that returns the session token in the response body. The plugin stores it via Obsidian's `saveData()` and sends it as `Authorization: Bearer TOKEN` on every request.

```
Settings Tab → Enter URL + credentials
       │
       ▼
POST /api/auth/token  ──►  Server validates  ──►  Returns {token, role}
       │
       ▼
Plugin stores token (saveData)
       │
       ▼
All requests: Authorization: Bearer TOKEN
       │
       ▼
If 401 → Prompt re-login
```

**Middleware change needed:** `routeRequest()` in `middleware.ts` currently only checks `cookies.get('ss_session')`. Must add fallback: check `request.headers.get('authorization')?.replace('Bearer ', '')` when cookie is absent.

See: [sequence-plugin-auth.md](./diagrams/sequence-plugin-auth.md) (Mermaid diagram)

---

## Sync Strategy: Direct API

The plugin syncs files through Silent Stone's REST API, NOT through Syncthing on the user's device.

### Upload (Local → Server)

1. File watcher (`vault.on('modify')`) detects change
2. Debounce for 2 seconds (avoid rapid-fire on autosave)
3. Read file via `vault.read(file)`
4. Upload via `POST /api/folders/:id/files` (multipart)
5. Update local sync state (path → last synced timestamp + hash)

### Download (Server → Local)

1. Every N minutes (configurable, default 5)
2. `GET /api/folders/:id/files` — list server files
3. Compare server state vs local sync state
4. Download new/changed files
5. Write to vault via `vault.create()` or `vault.modify()`

### State Tracking

```typescript
interface SyncState {
  /** Map of file path → sync metadata */
  files: Record<string, {
    localHash: string;      // MD5 of local content at last sync
    serverTimestamp: string; // Last modified time from server
    lastSynced: string;     // ISO timestamp of last successful sync
  }>;
  lastFullSync: string;     // ISO timestamp of last poll
}
```

Stored via `this.saveData()` alongside settings.

See: [sequence-plugin-sync.md](./diagrams/sequence-plugin-sync.md) (Mermaid diagram)

---

## Conflict Resolution

Conflicts occur when both local and server copies change between syncs.

### Detection

On upload: if server's file timestamp is newer than `lastSynced`, it's a conflict.
On download: if local file hash differs from `localHash` at last sync, it's a conflict.

### Resolution Options

| Option | What happens |
|--------|-------------|
| **Keep Local** | Upload local version, overwrite server |
| **Take Server** | Download server version, overwrite local |
| **Keep Both** | Save server version as `filename.conflict.md` alongside local |

### UI

A modal (`SyncConflictModal`) shows:
- File path
- Last synced time
- Local modification time
- Server modification time
- Preview of differences (if small enough)
- Three action buttons

---

## Encryption Model (v0.3 — Implemented)

The plugin uses **end-to-end encryption** — all vault data is encrypted on the user's device before upload. The server stores only encrypted blobs and has **zero knowledge** of file contents.

### Key Hierarchy

```
128-bit random entropy
    |
    +---> HKDF-SHA256 ---> 256-bit Master Key (encrypts all blobs)
    |
    +---> BIP39 encode ---> 12-word Recovery Phrase (human backup)
```

The master key never leaves the device in plaintext. It is wrapped (encrypted) with the user's password before being stored on the server.

### Crypto Components

| File | Purpose |
|------|---------|
| `crypto/keys.ts` | Master key generation, BIP39 recovery phrase, Argon2id password wrapping |
| `crypto/cipher.ts` | AES-256-GCM blob encryption and decryption |
| `crypto/types.ts` | TypeScript interfaces (`MasterKeyMaterial`, `WrappedKey`, `Argon2Params`, etc.) |

### How Key Wrapping Works

1. **Generate**: 128-bit random entropy -> HKDF-SHA256 -> 256-bit master key
2. **Backup**: Entropy encoded as 12-word BIP39 mnemonic (recovery phrase)
3. **Wrap**: User password -> Argon2id (64 MB, 3 iterations) -> 256-bit KEK -> AES-GCM encrypt master key
4. **Store**: Wrapped key + salt + Argon2 params sent to server via `POST /api/vault/keys/setup`
5. **Unwrap on new device**: Fetch wrapped key from server -> re-derive KEK from password -> AES-GCM decrypt

### How Blob Encryption Works

- **Upload**: Read file from vault -> `encryptBlob(plaintext, masterKey)` -> `PUT /api/vault/blobs/:id` (binary)
- **Download**: `GET /api/vault/blobs/:id` -> `decryptBlob(encrypted, masterKey)` -> write to vault
- **Format**: Each encrypted blob is `nonce (12 bytes) || ciphertext || GCM tag (16 bytes)`
- **Nonce**: Fresh random nonce per blob — never reused
- **Integrity**: AES-GCM authentication tag detects tampering or wrong key

### Recovery Scenarios

| Scenario | Resolution |
|----------|-----------|
| Forgot password | Enter 12-word recovery phrase -> re-wrap master key with new password |
| New device | Enter password -> fetch wrapped key from server -> unwrap in memory |
| Lost recovery phrase + lost password | **Unrecoverable** — server cannot help (zero-knowledge) |

See: [sequence-plugin-crypto.md](./diagrams/sequence-plugin-crypto.md) (Mermaid diagrams for all flows)

---

## Plugin Settings Data Model

```typescript
interface SilentStoneSyncSettings {
  // Connection
  serverUrl: string;        // e.g., "https://silentstone.one"
  nickname: string;         // Silent Stone username
  authToken: string;        // Bearer token from /api/auth/token

  // Sync
  folderId: string;         // Which server folder to sync with
  syncInterval: number;     // Minutes between auto-syncs (1-60)
  autoSync: boolean;        // Enable/disable auto-sync
  syncOnStartup: boolean;   // Sync immediately when Obsidian opens

  // Advanced
  ignorePaths: string[];    // Glob patterns to skip (e.g., ".obsidian/**")
  conflictStrategy: 'ask' | 'keep-local' | 'keep-server' | 'keep-both';
  debugLogging: boolean;
}
```

---

## Status Bar States

```
SS: Synced        (green dot)   — All files in sync
SS: Syncing...    (spinning)    — Active upload/download
SS: 3 conflicts   (yellow dot)  — Unresolved conflicts
SS: Offline       (red dot)     — Server unreachable
SS: Not connected (gray dot)    — No server configured
```

---

## Rate Limiting Considerations

Silent Stone's rate limiter (`rate-limit.ts`) has these limits relevant to the plugin:

| Action | Limit | Impact |
|--------|-------|--------|
| Login | 5/15min per IP | Plugin login retries |
| File upload | 10/min | **Blocks bulk sync** — initial vault upload with 100+ files will hit this |
| File delete | 10/min | Bulk cleanup operations |
| Mkdir | 10/min | Creating nested folder structures |

**Required server change:** Add a batch upload endpoint or increase rate limits for authenticated Bearer token requests.

---

## File Structure

See `obsidian-plugin/CLAUDE.md` for agent instructions and the full scaffold directory structure.

---

## Related Documents

- [OBSIDIAN_PLUGIN_DEV.md](./OBSIDIAN_PLUGIN_DEV.md) — Plugin API reference
- [API_ENDPOINTS.md](./API_ENDPOINTS.md) — Silent Stone server API reference
- [GOALS.md](./GOALS.md) — Product milestones including M3
- [SECURITY.md](./SECURITY.md) — Server security posture

### Diagrams

- [component-plugin-overview.md](./diagrams/component-plugin-overview.md) — System component overview (includes crypto module)
- [sequence-plugin-auth.md](./diagrams/sequence-plugin-auth.md) — Bearer token auth flow
- [sequence-plugin-sync.md](./diagrams/sequence-plugin-sync.md) — E2E encrypted sync cycle
- [sequence-plugin-crypto.md](./diagrams/sequence-plugin-crypto.md) — Key hierarchy, wrapping, recovery, and blob encryption
