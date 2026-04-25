# Silent Stone Sync — Obsidian Plugin

[![Plugin Release](https://github.com/josemoreno801-netizen/silent-stone-obsidian/actions/workflows/plugin-release.yml/badge.svg)](https://github.com/josemoreno801-netizen/silent-stone-obsidian/actions/workflows/plugin-release.yml)

Open-source Obsidian plugin for the [Silent Stone](https://silentstone.one) encrypted vault sync service.

## Why this repo is public

Silent Stone promises **end-to-end encryption**: your notes are encrypted on your device before they ever reach our server. We never see plaintext. We never see your keys.

That's a strong claim. You shouldn't just take our word for it — you should be able to **verify it yourself**.

That's why this plugin is open source. Everything that touches your unencrypted notes — the crypto, the key derivation, the network layer — lives in this repo. You can read it, audit it, build it yourself, and confirm the ciphertext leaving your machine is what we say it is.

- **Crypto implementation**: [`src/crypto/`](./src/crypto/) — AES-256-GCM, BIP39 recovery phrases, Argon2id key derivation
- **Network layer**: [`src/api/vault-client.ts`](./src/api/vault-client.ts) — every HTTP request the plugin makes
- **Sync engine**: [`src/sync/`](./src/sync/) — what gets synced, when, and how

The Silent Stone server code is **proprietary** (it handles billing, admin dashboards, and infrastructure that isn't security-critical). Its privacy doesn't weaken the encryption claim — only the plugin ever touches plaintext, and the plugin is fully visible here.

## Install

### Via BRAT (recommended for early access)

1. Install the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin in Obsidian
2. Open BRAT settings → "Add Beta Plugin"
3. Paste: `josemoreno801-netizen/silent-stone-obsidian`
4. Enable the plugin in Obsidian → Settings → Community Plugins
5. Open the plugin settings, paste your Silent Stone server URL and vault credentials

BRAT will auto-update the plugin on every release.

### Via manual install

Download the latest [release assets](https://github.com/josemoreno801-netizen/silent-stone-obsidian/releases/latest):

- `main.js`
- `manifest.json`
- `styles.css`

Drop them into `<your-vault>/.obsidian/plugins/silent-stone-sync/`. Reload Obsidian. Enable the plugin.

## How the encryption works (short version)

1. You enter a password. The plugin runs it through **Argon2id** (memory-hard KDF) to derive a master key.
2. Your master key never leaves your device. The server stores only an **encrypted-at-rest copy** of it, wrapped with your password — the server can't unwrap it without your password.
3. Every file, before upload, is encrypted with **AES-256-GCM** using a per-file key derived from the master key.
4. The server sees: opaque binary blobs + a unique ID per blob. Nothing about the content, filename, or structure.
5. On download, your plugin decrypts locally using the master key in memory.

Full technical details in [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).

## Recovery

If you forget your password, you can restore your vault using a **12-word BIP39 recovery phrase** that was generated on first-time setup. The phrase encodes your master key directly — Silent Stone has no way to recover your vault without either your password or your recovery phrase. **Store it somewhere safe.**

## Build from source

```bash
git clone https://github.com/josemoreno801-netizen/silent-stone-obsidian.git
cd silent-stone-obsidian
npm install         # uses legacy-peer-deps=true (see .npmrc)
npm run build       # produces main.js
npm test            # runs vitest suite
```

See [`CLAUDE.md`](./CLAUDE.md) for the full developer reference, including the `.npmrc` dependency-resolution trap and the release pipeline.

## Security audits and disclosure

If you find a vulnerability, **please do not open a public issue**. Email `jose.moreno801@outlook.com` with:

- A description of the issue
- Steps to reproduce
- Which commit/version you tested against

We take security reports seriously and will respond within 72 hours. Responsible disclosure is welcome and credited.

For non-vulnerability audit notes (design critique, key-handling observations, crypto choices), open a regular GitHub issue labeled `security-review`.

## Contributing

Contributions welcome — especially security reviews and crypto audits.

1. Fork, branch, code
2. `npm run lint && npm run typecheck && npm test` before opening a PR
3. Keep PRs focused — one concern per PR
4. The `main` branch is the only long-lived branch; releases cut from tags (`plugin-v*`)

## License

MIT — see [`LICENSE`](./LICENSE).

## Related

- **Silent Stone** (the service): https://silentstone.one
- **Server code** (proprietary, not public): handles storage of encrypted blobs, billing, admin dashboard
- **Obsidian**: https://obsidian.md

---

*Silent Stone Sync — your notes, your keys, your trust.*

Copilot dispatch verification probe 2026-04-25 — disregard.
