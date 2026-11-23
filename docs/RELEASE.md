# Developer release guide

You work on Linux and push to GitHub. The shop owner's Windows computer updates itself the next time the app is opened.

## How it fits together

| Part | Where |
| --- | --- |
| Business rules, ledger, reports, backups, migrations | `crates/pos-core` (Rust, SQLite, `cargo test -p pos-core`) |
| Windows app shell, updater, photo file server | `src-tauri` (Tauri 2) |
| Screens | `src` (React and TypeScript) |
| Browser test server (same core, used by the end to end tests) | `crates/pos-dev` |
| End to end tests through the real screens | `e2e/run.mjs` |
| Database migrations | `crates/pos-core/migrations/NNNN_name.sql`, listed in `crates/pos-core/src/db.rs` |
| Release pipeline | `.github/workflows/release.yml` |

The owner's data lives in `%LOCALAPPDATA%\ShopPOS Data` (database, photos, logo, settings, local safety copies, logs). It is outside the install folder, so installs, updates and uninstall never touch it. Nothing in that folder is ever sent to GitHub.

## Daily work

```bash
npm ci
cargo test -p pos-core            # ledger, reports, backup, restore, migration tests
npm run build                     # typecheck and build the screens
cargo build -p pos-dev --release
npm run test:e2e                  # drives the real screens in Chromium
```

To try the screens in a browser: `SHOPPOS_DATA_DIR=/tmp/shop npm run devserver` and `npm run dev`, then open http://localhost:5173.

## Shipping a change to the shop

1. Commit and `git push` to `main`. That is all.
2. GitHub Actions gives the build a new version number by itself (`0.1.<run number>`), runs all tests on Linux, runs the core tests again and builds the signed installer on Windows, installs it there and checks that the app starts, verifies the update signature, then publishes `ShopPOS_<version>_x64-setup.exe`, its `.sig` and `latest.json` as a GitHub release in this repository.
3. Next time the owner closes and opens the app, it downloads the new version, checks its signature, installs it and opens again. If anything is wrong with the update, it is refused and the current version opens. The owner's data folder is never touched by an update.

Nothing is published if any test fails. Pushes that only change `.md` files or `docs/` do not make a release. To change the first two parts of the version (for example 0.2.x), run `npm run version:set -- 0.2.0` and push.

## Changing the database

Never edit a migration that has shipped. Add a new file, for example `crates/pos-core/migrations/0003_supplier_phone.sql`, and add it to `MIGRATIONS` in `crates/pos-core/src/db.rs` with the next number.

On first start after an update, the app:
1. makes a checked copy of the database in `ShopPOS Data\backups\before-update\`,
2. applies each new migration inside a transaction (a failure rolls back completely),
3. refuses to open a database whose version is newer than it understands (an older app never touches newer data),
4. never creates an empty database when the shop data file is missing; it asks for a restore instead.

Business tables cannot be deleted or edited at the database level (triggers). Corrections are new linked records (reversal, return, stock correction).

## One-time setup

### 1. Repository

The repository `Arslanarsal/shoppos-releases` holds the code and also the published installers (GitHub Releases). It is public, so the shop computer downloads updates without any login. No customer data and no keys are in it. To keep the code private instead, make it private, create a separate public repository for releases, set the variable `RELEASES_REPO` to it and add `RELEASES_TOKEN` (a token with Contents write on that repository).

### 2. Signing key

The update signing key was generated on the development machine:

- private key: `~/.tauri/shoppos.key`
- its password: `~/.tauri/shoppos.key.password`
- public key: `~/.tauri/shoppos.key.pub` (already in `src-tauri/tauri.conf.json`)

Keep a copy of the private key and password somewhere safe offline (a password manager). If it is lost, installed apps can no longer be updated and must be reinstalled by hand once. Never commit it.

To make a new key: `npx tauri signer generate -w ~/.tauri/shoppos.key`, then put the new public key in `tauri.conf.json` (and the variable below).

### 3. GitHub settings (one time)

Repository Settings, Secrets and variables, Actions, New repository secret:

| Name | Value |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | contents of `~/.tauri/shoppos.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | contents of `~/.tauri/shoppos.key.password` |

Repository Settings, Actions, General, Workflow permissions: choose **Read and write permissions** (lets the workflow publish releases with its built in token).

### 4. Optional: Windows code signing

The update signature above protects updates. Windows SmartScreen may still warn on the first manual install because the installer is not signed with a paid code signing certificate. Click "More info" then "Run anyway" once. To remove the warning, buy a code signing certificate and add `bundle.windows.signCommand` in `tauri.conf.json`.

## Building the installer on Linux (no CI)

```bash
rustup target add x86_64-pc-windows-msvc
cargo install --locked cargo-xwin
sudo apt install nsis clang lld llvm
TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/shoppos.key)" \
TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(cat ~/.tauri/shoppos.key.password)" \
npx tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc
```

Output: `target/x86_64-pc-windows-msvc/release/bundle/nsis/`.

## Windows 10

The app uses Microsoft WebView2, which Windows 10 (version 1803 and newer) gets through Windows Update. If a computer does not have it, the installer installs it (an internet connection is needed for that first install only). After that the app works offline.

## Testing updates by hand on Windows

Environment variables read by the app (for testing only):

| Variable | Effect |
| --- | --- |
| `SHOPPOS_UPDATE_URL` | use another update feed, for example a local `latest.json` |
| `SHOPPOS_NO_UPDATE=1` | skip the update check |
| `SHOPPOS_DATA_DIR` | use another data folder |
| `SHOPPOS_TEST_BAD_MIGRATION=1` | add a migration that fails, to see the recovery screen |

The update log is `ShopPOS Data\logs\updates.log`.

## Recovery

| Problem | What to do |
| --- | --- |
| Update failed to prepare data | The app shows a recovery screen; data is untouched. Fix and publish a new version, or send the previous installer. |
| Computer died | Install ShopPOS on the new computer, choose Restore from backup, pick the backup drive. |
| Shop data file missing | The app refuses to start empty and offers Restore from backup. |
| Restore replaced the wrong data | The previous data is kept in `ShopPOS Data\replaced\<date>`. |
