# LiteSync

**Private, self-hosted sync for Obsidian.**

LiteSync keeps your vaults in sync across desktop and mobile devices through a
lightweight server that you host yourself — your notes never touch anyone
else's cloud.

[中文文档 / Chinese documentation →](README.zh.md)

> **Requires a LiteSync Server.** LiteSync does not operate a hosted sync
> service; you deploy your own server (a single Docker container, happily
> running on a 1-core / 256MB VPS):
> **<https://github.com/KJoner/litesync-server>**

## Features

- **Incremental sync** — per-file revisions + SHA-256 + a global change
  sequence; offline edits queue up and retry with exponential backoff
- **Conflict handling** — automatic three-way merge for Markdown (diff3);
  overlapping edits open a conflict resolver UI; anything unresolvable falls
  back to keeping both versions — no content is ever lost
- **Version history** — every change creates an immutable version on the
  server; compare, restore, or save a copy of any revision
- **End-to-end encryption** — PBKDF2 (600k iterations) + AES-256-GCM; the
  password and master key never leave your devices, the server only ever
  stores ciphertext
- **Trusted device** — remember device authorization (split-key wrapping via
  Obsidian SecretStorage) instead of your password
- **Encrypted sharing** — share a single note via a link whose key lives only
  in the URL fragment; revocable, with optional expiry
- **Mobile support** — works on iOS/Android (Obsidian 1.11.4+): foreground
  catch-up sync, deletion safety (never permanently deletes), responsive UI

## Installation

Until LiteSync is available in Community Plugins, install manually:

1. Download `main.js`, `manifest.json`, `styles.css` from the
   [latest release](https://github.com/KJoner/litesync/releases)
2. Copy them into `<YourVault>/.obsidian/plugins/litesync/`
3. Enable **LiteSync** in Settings → Community plugins

Then open the plugin settings, fill in your **Server URL** and **API Token**
(shown by the server's install script), and hit **Test Connection**.

Don't have a server yet? Follow the
[deployment guide](https://github.com/KJoner/litesync-server) — a one-line
install script sets everything up.

## Privacy & Network Access

- LiteSync connects **only** to the LiteSync Server URL configured by the
  user. It makes no other network requests — no telemetry, no analytics, no
  third-party services, no accounts.
- LiteSync does **not** operate a hosted sync service. Your notes are
  synchronized exclusively to your own server.
- When end-to-end encryption is enabled, note contents are encrypted with
  AES-256-GCM **before leaving the device**; the server only stores
  ciphertext and cannot read your notes.
- The API token is stored in Obsidian's SecretStorage (never in plain-text
  `data.json`).
- The server component is a separate open-source project:
  <https://github.com/KJoner/litesync-server>

## Development

```bash
npm install
npm run build        # type-check + bundle to main.js
npm test             # unit tests (merge engine / crypto / device trust / state)
npm run test:mobile  # mobile CI: Node/Electron dependency audit + build + tests
npm run dev          # watch mode
```

Releases are automated: pushing a tag that matches `manifest.json`'s version
builds the plugin and drafts a GitHub Release with `main.js`,
`manifest.json`, and `styles.css` attached.

## License

[MIT](LICENSE)
