# LiteSync

**Private, self-hosted sync for Obsidian.** Your notes sync through a
lightweight server that you run yourself — end-to-end encrypted, with version
history and automatic merge. No third-party cloud, no account, no telemetry.

Works on desktop and mobile (Obsidian 1.13+).
[中文文档 / Chinese documentation →](README.zh.md)

> **Requires a LiteSync Server** — a single Docker container you deploy with
> one command (runs happily on a 1-core / 256MB VPS):
> **<https://github.com/KJoner/litesync-server>**

## Getting started (first device)

1. Deploy the server — one line on your VPS, it prints your API token when done:

   ```bash
   bash <(wget -qO- https://raw.githubusercontent.com/KJoner/litesync-server/master/scripts/litesync-install.sh)
   ```

2. Install LiteSync in Obsidian and open its settings
3. Fill in **Server URL** and **API Token**, hit **Test Connection**
4. Follow the onboarding wizard — it will offer to initialize the remote
   vault from this device
5. (Optional) Enable **end-to-end encryption** in settings and set a password

That's it — edits now sync automatically in the background.

## Adding a new device (QR pairing)

You never type the server config twice:

1. On a configured device: Settings → **Devices & migration** → **Add device**
2. On the new device: install LiteSync, then scan the QR code with the system
   camera (or open the pairing link) → **Open in Obsidian** → confirm import
3. If E2EE is enabled, type your password once (it is never transmitted)
4. In the onboarding wizard, pick **Restore from remote** — done

The pairing package is encrypted on-device and expires in 5 minutes after a
single use; the server only ever sees ciphertext. If your vault on the new
device already has notes, the wizard offers a safe **merge** instead — nothing
is ever silently overwritten, and nothing is ever permanently deleted.

## Features

- **Incremental sync** — per-file revisions + SHA-256 + a global change
  sequence; offline edits queue up and retry with exponential backoff;
  mobile catches up automatically when the app returns to the foreground
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
- **Onboarding wizard** — new devices explicitly choose *restore from remote*
  or *merge* before any sync happens; the server's stable vault identity is
  verified so a reinstalled server can never silently clobber your notes
- **Deletion safety** — remote deletions go to the trash on every platform;
  if trashing fails the file is kept and flagged, never permanently deleted
- **Web read-only client & off-site backup** — the server ships an embedded
  browser reader (decrypts locally) and optional Restic → Cloudflare R2
  disaster backup, managed from a web admin page

## Privacy & Network Access

- LiteSync connects **only** to the LiteSync Server URL configured by the
  user. It makes no other network requests — no telemetry, no analytics, no
  third-party services, no accounts.
- LiteSync does **not** operate a hosted sync service. Your notes are
  synchronized exclusively to your own server.
- When end-to-end encryption is enabled, note contents are encrypted with
  AES-256-GCM **before leaving the device**; the server only stores
  ciphertext and cannot read your notes.
- Path and filename encryption is available as an **experimental (RC)**
  feature, disabled by default: the server only sees random pseudonyms and
  real paths live inside encrypted metadata. Since v0.13 the migration keeps
  deletion barriers intact (tombstones are converted, never dropped), but the
  erasure step is still irreversible and pre-migration backups still contain
  plaintext paths — do not enable it on your only real vault.
- Each device holds its own least-privilege credential (v0.10): the root
  server token is exchanged for a per-device token on first sync and never
  stays on devices afterwards. A lost device can be revoked individually on
  the server without rotating anything else.
- The API token is stored in Obsidian's SecretStorage (never in plain-text
  `data.json`).
- Non-loopback `http://` server URLs are rejected — credentials and notes
  never travel over plain HTTP.
- As a sync plugin, LiteSync enumerates the files in your vault to determine
  what needs syncing. File paths and contents go only to your own configured
  server, nowhere else.
- The system clipboard is written **only** when you explicitly click
  "Copy link" for an encrypted share or a device-pairing link. LiteSync never
  reads the clipboard.
- Device pairing never transmits your E2EE password. The pairing package
  (server URL, a one-time enrollment secret, sync settings — **not** the
  root token as of v0.10) is encrypted on-device; the decryption key lives
  only in the link's `#fragment`, which browsers do not send to servers.
- The server component is a separate open-source project:
  <https://github.com/KJoner/litesync-server>

## Known limitations & remaining threats

Being explicit about what LiteSync does **not** protect against is part of the
design. The list below is accurate as of v0.17.0-rc.1.

### What a malicious or compromised server can still do

End-to-end encryption means the server cannot **read** your notes. It does not
mean the server is trusted with everything else. Today the client detects and
hard-fails on the attacks it can anchor locally:

| Attack | Detected? | How |
|---|---|---|
| Return someone else's content as your file | ✅ | fileId must match the object we asked for |
| Replay an older version of a file | ✅ | contentGeneration must not go backwards |
| Replay older metadata (e.g. undo a rename) | ✅ | authenticated metaGeneration must not go backwards |
| Serve two different metadata at the same generation | ✅ | metadata fingerprint mismatch = fork, sync stops |
| Downgrade the encryption envelope | ✅ | repository-wide envelope floor, envelopes only move up |
| Feed a path-traversal filename via crafted metadata | ✅ | decrypted paths are validated before touching disk |
| Roll the repository back to an old backup | ✅ | repoEpoch change forces an explicit recovery merge |
| Show device A one repository state and device B another | ✅ (v0.15) | device-signed checkpoints; a fork stops sync instead of picking a side |
| Roll back to an older repository state after you synced | ✅ (v0.15) | the trust anchor only moves forward, and every checkpoint must link to a chain you have seen |
| **Withhold a file you have never seen** | ❌ | there is no local anchor for something you never had, and no proof that the server handed you the complete set |

That last row is the honest, **structural** gap — not a missing feature.
The accurate claim is:

> A malicious server cannot roll back or swap content you have already synced
> without being detected, and cannot keep showing different repository states
> to different devices of yours. It can still refuse to serve you, and it can
> still hide a file you have never seen.

Signed checkpoints (v0.15) are signed by your **devices**, never by the server.
A new device does not trust the first manifest the server offers — it receives a
trusted anchor through device pairing, whose key travels only in the link's
`#fragment`.

### Path and filename encryption is still RC

Disabled by default. The migration is resumable and keeps deletion barriers
intact, but the final erasure step is irreversible and any backup taken before
the migration still contains plaintext paths. Do not enable it on a vault that
has no copy.

### Platform limitations

- On platforms that cannot guarantee an atomic file replace, overwriting an
  existing file automatically degrades to saving the incoming version alongside
  the local one, rather than risking a half-written file. Every platform we have
  measured so far (Windows, Linux, macOS, iOS, Android) **does** support atomic
  installs, so this path is a safety net rather than an everyday behaviour. The
  plugin probes for it at runtime instead of assuming — run **"LiteSync:
  Platform compatibility probe"** to see the result for your own device.
- `Note.md` and `note.md` are treated as **the same file** regardless of which
  operating system you are on, and `café.md` written as NFC or NFD is likewise
  one file. This is deliberate, and measurement backs it up: on real devices
  **iOS is case-sensitive and normalises Unicode, while Android is the
  opposite** — case-insensitive and non-normalising. Judging by the local
  platform would make those two devices disagree about whether two names
  collide, and they would then overwrite each other. The rule therefore takes
  the strictest interpretation across all platforms. The cost is that you
  cannot keep `Note.md` and `note.md` as separate files even on a system that
  allows it; the benefit is that no device can silently overwrite another's.
- Network drives and cloud-sync folders (Dropbox, OneDrive, iCloud Drive) are
  **not supported** as vault locations. Two synchronizers writing the same
  files will corrupt each other's state.

### Scale

Officially supported and tested limits are documented in the
[server README](https://github.com/KJoner/litesync-server#正式支持规模):
20 000 files per vault, 100 MB per file, 90 days offline. Beyond those numbers
things are not broken by design — they are simply untested.

## Manual installation

Until LiteSync is available in Community Plugins:

1. Download `main.js`, `manifest.json`, `styles.css` from the
   [latest release](https://github.com/KJoner/litesync/releases)
2. Copy them into `<YourVault>/.obsidian/plugins/litesync/`
3. Enable **LiteSync** in Settings → Community plugins

## Development

```bash
npm install
npm run build        # type-check + bundle to main.js
npm run lint         # eslint-plugin-obsidianmd recommended rules
npm test             # unit tests (merge engine / crypto / pairing / state)
npm run test:mobile  # mobile CI: Node/Electron dependency audit + build + tests
npm run dev          # watch mode
```

Releases are automated: pushing a tag that matches `manifest.json`'s version
lints, builds, attests provenance, and drafts a GitHub Release with `main.js`,
`manifest.json`, and `styles.css` attached.

## License

[MIT](LICENSE)
