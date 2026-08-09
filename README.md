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
- **Mobile support** — works on iOS/Android (Obsidian 1.13+): foreground
  catch-up sync, deletion safety (never permanently deletes), responsive UI
- **First-run wizard & QR pairing** — new devices go through an onboarding
  wizard (restore from remote / merge, nothing is ever silently overwritten);
  "Add device" generates a one-time encrypted QR code that transfers server
  config to a new device — the E2EE password is always typed manually

## Installation

Until LiteSync is available in Community Plugins, install manually:

1. Download `main.js`, `manifest.json`, `styles.css` from the
   [latest release](https://github.com/KJoner/litesync/releases)
2. Copy them into `<YourVault>/.obsidian/plugins/litesync/`
3. Enable **LiteSync** in Settings → Community plugins

**First device:** open the plugin settings, fill in your **Server URL** and
**API Token** (shown by the server's install script), hit **Test Connection**,
then follow the onboarding wizard (it will offer to initialize the remote
vault from this device).

**Second and later devices:** on an already-configured device, open
Settings → Devices & migration → **Add device** and scan the QR code (or open
the pairing link) on the new device. Server config is transferred through a
one-time encrypted package (5-minute expiry, single use; the server only ever
sees ciphertext). Enter your E2EE password once, pick **Restore from remote**
in the wizard, done.

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
- As a sync plugin, LiteSync enumerates the files in your vault to determine
  what needs syncing. File paths and contents go only to your own configured
  server, nowhere else.
- The system clipboard is written **only** when you explicitly click
  "Copy link" for an encrypted share or a device-pairing link. LiteSync never
  reads the clipboard.
- Device pairing never transmits your E2EE password. The pairing package
  (server URL, API token, sync settings) is encrypted on-device; the
  decryption key lives only in the link's `#fragment`, which browsers do not
  send to servers.
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
