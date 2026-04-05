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
    ├── status-bar.ts # Status bar display
    └── sync-modal.ts # Manual sync trigger, conflict resolution modal
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

## Server API Dependencies

The plugin calls these Silent Stone endpoints (see `docs/API_ENDPOINTS.md`):

| Endpoint | Purpose | Status |
|----------|---------|--------|
| `POST /api/auth/token` | Login, get Bearer token | **Not yet built** |
| `GET /api/auth/me` | Validate session | Exists |
| `GET /api/folders` | List folders | Exists (admin-only) |
| `GET /api/folders/:id/files` | List files | Exists (admin-only) |
| `POST /api/folders/:id/files` | Upload | Exists (admin-only) |
| `GET /api/health` | Health check | Exists (public) |

## Submission Rules

- ID: no "obsidian", no ending "plugin" → `silent-stone-sync`
- Name: no "Obsidian", no ending "Plugin" → `Silent Stone Sync`
- Description: no "This plugin", must end with `.?!)`, under 250 chars
- ESLint: `eslint-plugin-obsidianmd` with 27 rules
- All events via `registerEvent()`, secrets via `SecretComponent`

## Related Docs

- `docs/OBSIDIAN_PLUGIN_DEV.md` — API reference
- `docs/OBSIDIAN_PLUGIN_ARCHITECTURE.md` — System design + diagrams
- `docs/API_ENDPOINTS.md` — Server API reference
