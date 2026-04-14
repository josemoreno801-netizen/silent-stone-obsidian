# CLAUDE.md — Silent Stone Sync Obsidian Plugin

## Overview

Obsidian community plugin that syncs vaults through a private Silent Stone server via REST API. No Syncthing required on the user's device.

## Commands

```bash
npm install          # Install dependencies
npm run dev          # Watch mode (esbuild rebuilds on change)
npm run build        # Production build
npm run lint         # ESLint with obsidian plugin rules
npm run typecheck    # TypeScript check
npm test             # Run vitest (src/**/__tests__/**/*.test.ts)
npm run test:watch   # Vitest in watch mode
```

## Architecture

```
src/
├── main.ts          # Plugin entry — lifecycle, commands, ribbon, status bar
├── settings.ts      # Settings tab — connection, sync, advanced options
├── types.ts         # Settings interface, sync state types
├── api/
│   ├── client.ts    # HTTP client wrapping requestUrl() with Bearer auth
│   └── types.ts     # API response types (mirrors server's folder-types.ts)
├── sync/
│   ├── engine.ts    # Diff logic, upload/download orchestration
│   └── watcher.ts   # Vault event listener, debounced change queue
└── ui/
    ├── status-bar.ts  # Status bar display
    ├── unlock-modal.ts # Password unlock modal (command: "Vault: unlock with password")
    └── sync-modal.ts  # Manual sync trigger, conflict resolution modal (placeholder)
```

## Key Patterns

- **esbuild** builds to `main.js` (CJS format, es2018 target)
- **requestUrl()** for all HTTP — bypasses CORS, works on desktop + mobile
- **Bearer token auth** — existing `/api/auth/login` uses `Set-Cookie` with `SameSite=Strict` which doesn't work cross-origin. Uses new `/api/auth/token` endpoint.
- **Vault API over Adapter API** — Vault has caching + serialized writes. Use `cachedRead()` for display, `read()` before modify, `process()` for atomic read-modify-write.
- **registerEvent()** for all event listeners — auto-cleanup on unload
- **saveData()/loadData()** for persistence — settings + sync state
- **SecretComponent** for auth token storage (not plain text)
- **`obsidian` is external** — provided by Obsidian runtime, never bundled
- **CSRF gotcha** — Bodiless mutation requests (DELETE with no body) return 403 behind Caddy. Use `Content-Type: application/json` header on ALL mutation requests, even via `requestUrl()`.

## Server API Dependencies

Two API clients, two product tracks (see `docs/API_ENDPOINTS.md`):

### Syncthing Track (`SilentStoneClient` in `api/client.ts`)

| Endpoint | Purpose | Status |
|----------|---------|--------|
| `GET /api/auth/me` | Validate session | Exists |
| `GET /api/folders` | List folders | Exists (admin-only) |
| `GET /api/folders/:id/files` | List files | Exists (admin-only) |
| `POST /api/folders/:id/files` | Upload | Exists (admin-only) |
| `GET /api/health` | Health check | Exists (public) |

### Vault Track (`VaultClient` in `api/vault-client.ts`)

| Endpoint | Purpose | Status |
|----------|---------|--------|
| `POST /api/vault/token` | Get Bearer token (90-day) | Exists |
| `GET /api/vault/status` | Storage quota + metadata | Exists |
| `GET/PUT /api/vault/manifest` | Encrypted manifest (binary, optimistic concurrency) | Exists |
| `GET/PUT/DELETE /api/vault/blobs/:id` | Encrypted blob CRUD (binary) | Exists |
| `POST /api/vault/blobs/batch` | Batch blob upload (base64 JSON) | Exists |
| `POST /api/vault/keys/setup` | Register encrypted master key | Exists |
| `GET/PUT /api/vault/keys` | Retrieve/update encrypted key + Argon2 params | Exists |

## Submission Rules

- ID: no "obsidian", no ending "plugin" → `silent-stone-sync`
- Name: no "Obsidian", no ending "Plugin" → `Silent Stone Sync`
- Description: no "This plugin", must end with `.?!)`, under 250 chars
- ESLint: `eslint-plugin-obsidianmd` with 27 rules
- All events via `registerEvent()`, secrets via `SecretComponent`

## Crypto Module Gotchas

- **`@noble/hashes` / `@scure/bip39` imports** — Must use `.js` extensions (`@noble/hashes/argon2.js`, not `argon2`). ESM exports maps are strict, vitest enforces them.
- **TS 5.7 BufferSource compat** — `@noble` returns `Uint8Array<ArrayBufferLike>`, Web Crypto needs `ArrayBuffer`. Use `toBuffer()` from `crypto/keys.ts` to copy bytes into fresh `ArrayBuffer`.
- **`npm run typecheck` noise** — vitest/vite transitive `.d.ts` errors from `moduleResolution: "node"`. Our `src/` code is clean — filter with `npx tsc --noEmit 2>&1 | grep "^src/"`.

## Related Docs

- `docs/OBSIDIAN_PLUGIN_DEV.md` — API reference
- `docs/OBSIDIAN_PLUGIN_ARCHITECTURE.md` — System design + diagrams
- `docs/API_ENDPOINTS.md` — Server API reference
