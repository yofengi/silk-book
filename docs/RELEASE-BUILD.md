# Installer builds

`.github/workflows/build-installers.yml` builds installers on version tags (`v0.2.0`) or a manual Actions run. It has read-only repository permissions and does not create or publish a Release. Maintainers review and upload the resulting files after the build succeeds.

| Installer | Native runner | Rust target |
| --- | --- | --- |
| Windows x64 NSIS | `windows-2022` | `x86_64-pc-windows-msvc` |
| macOS Apple Silicon DMG | `macos-15` | `aarch64-apple-darwin` |
| macOS Intel DMG | `macos-15-intel` | `x86_64-apple-darwin` |

Each job runs the translation and window lifecycle checks, builds with the lockfiles, runs the Rust tests, then uploads its installer and signed updater package. The final `silk-book-installers` artifact contains three installers, two macOS update archives, three detached updater signatures, a verified three-platform `latest.json`, individual binary `.sha256` files, and `SHA256SUMS.txt`. Artifact retention is 30 days.

The release filenames are:

```text
silk-book-0.2.0-windows-x64-setup.exe
silk-book-0.2.0-windows-x64-setup.exe.sig
silk-book-0.2.0-macos-arm64.dmg
silk-book-0.2.0-macos-arm64.app.tar.gz
silk-book-0.2.0-macos-arm64.app.tar.gz.sig
silk-book-0.2.0-macos-x64.dmg
silk-book-0.2.0-macos-x64.app.tar.gz
silk-book-0.2.0-macos-x64.app.tar.gz.sig
latest.json
SHA256SUMS.txt
```

`scripts/prepare-release-artifact.mjs` reads the version from `package.json` and `tauri.conf.json`, rejects mismatches and ambiguous or empty bundle output, copies each package under its release filename, and generates its checksum. A tag-triggered run also requires the tag to match the version. Both staging and aggregation verify updater signatures, including their signed version, against the application's configured public key. The final job verifies every platform before generating the release feed. Notes come from `docs/releases/v<version>.md`.

The repository's `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` Actions secrets are exposed only to the native build step. Keep the corresponding local encrypted key and password in a restricted, Git-ignored backup. Never rotate the key casually: existing clients trust the embedded public key. These updater signatures are separate from Windows Authenticode and Apple code signing/notarization.

Publish the complete artifact set in one Release, including `latest.json` at the version-specific download URL. Running downloads pin that version's feed so a later release does not change the selected installer. Only mark a release latest after all three platforms and signatures have passed verification.

## Local commands

Install the [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/), the pnpm version from `package.json`, Node.js 22, and Rust stable. Run macOS builds on macOS.

Signed local bundles also require `TAURI_SIGNING_PRIVATE_KEY` (key contents or the supported private key path) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` in the build environment. `tauri build` signs with the configured application version automatically. For development without installer output, use `pnpm tauri dev` or `pnpm tauri build --no-bundle`.

```sh
pnpm install --frozen-lockfile
rustup target add x86_64-pc-windows-msvc
pnpm tauri build --ci --target x86_64-pc-windows-msvc --bundles nsis -- --locked
node scripts/prepare-release-artifact.mjs windows-x64
```

```sh
rustup target add aarch64-apple-darwin
pnpm tauri build --ci --target aarch64-apple-darwin --bundles app,dmg -- --locked
cargo test --locked --manifest-path src-tauri/Cargo.toml --target aarch64-apple-darwin
node scripts/prepare-release-artifact.mjs macos-arm64
```

For Intel macOS, replace the target with `x86_64-apple-darwin` and the script argument with `macos-x64`. The staging script expects Tauri's target-specific output directory, so keep the explicit `--target` argument.

macOS builds must select both `app` and `dmg`. With `bundle.createUpdaterArtifacts: true`, the explicit `app` target creates `Boshu.app.tar.gz` and its `.sig` in `bundle/macos`; `dmg` creates the installation disk image in `bundle/dmg`. Selecting only `dmg` creates a temporary app for the disk image but does not generate the updater archive. `tauri.macos.conf.json` selects both targets for normal local builds, and CI passes `--bundles app,dmg` explicitly. See [Tauri's updater artifact documentation](https://v2.tauri.app/plugin/updater/#building) and the [CLI bundler's archive condition](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.0/crates/tauri-bundler/src/bundle.rs#L245).

```sh
node --test scripts/prepare-release-artifact.test.mjs
```

## Windows startup regression check

With Playwright available through `QA_PLAYWRIGHT`, run `node scripts/qa-startup-native.mjs` against the built release executable. It launches with an isolated profile and records Win32 visibility, window rectangles, and frontend readiness in `artifacts/qa-startup-*`. It refuses to run while another Boshu instance or its debugging port is in use. `QA_STARTUP_CASES=normal,remembered,maximized,memory-off` selects the full startup geometry matrix. `QA_EXECUTABLE` can select another executable; `--baseline` records an older version without requiring the new readiness markers.

The check requires a visible Windows desktop. A DOM toolbar alone is insufficient: hidden windows can already have a mounted editor while their native frame is still being prepared. The assertions therefore use stored frontend readiness marks, the first native visible rectangle, and settled client dimensions.

`scripts/qa-background-update-native.mjs` tests a separately built `0.1.99` QA client against the public signed release. Its Tauri config must use a separate identifier and an `appDirectoriesOverride.cache` inside a disposable artifact directory. It verifies real download progress, shared tasks across two windows, one completion popup, cancellation, and restart cache restoration. It intercepts every quit approval as refusal, so it cannot start the installer. Keep this QA executable separate from published binaries.

The Windows CI job additionally runs `scripts/qa-windows-installer.ps1` on its disposable runner. It verifies silent first install, the updater's `/S /UPDATE /R` path, restart, and settings/document preservation. The script refuses to run outside GitHub Actions because NSIS writes product registrations even when a temporary destination is supplied.

## macOS configuration

Tauri automatically merges `src-tauri/tauri.macos.conf.json`. It enables the transparent-window API, bundles the existing icon as ICNS and PNG, uses a minimum macOS version of 11.0, and uses the ad-hoc signing identity `-`. No Apple certificate or notarization credentials are needed for this configuration. Ad-hoc signing is not Apple notarization; downloaded apps can require approval in Privacy & Security. See [Tauri's signing guide](https://v2.tauri.app/distribute/sign/macos/).

The Tauri CLI manages the required `macos-private-api` Cargo feature from this configuration. The CI therefore runs the native Rust tests after `tauri build`, so the Cargo manifest and merged configuration agree. Both the signed `.app` updater archive and the DMG are built from the application bundle. CI mounts the finished DMG read-only, checks its embedded app with `codesign --verify --deep --strict`, and smoke-tests that executable with an isolated HOME before uploading. The startup check requires both an onscreen app window through Core Graphics and a successful frontend-ready confirmation, catching a process that remains hidden or only displays the startup failure fallback.

Settings, window state, and themes use `~/Library/Application Support/Boshu` on macOS. Windows keeps `%APPDATA%\Boshu`. macOS enumerates fonts through CoreText and uses AppKit's native frontmost window hit test for cross-window tab drops. Windows file associations and spell checking remain Windows-specific APIs.

The macOS application menu uses a regular Quit item with Cmd+Q, which starts the shared quit vote. Cocoa termination requests, including Dock Quit, are cancelled at `applicationShouldTerminate:` and routed through the same protocol. Dirty confirmation and pending settings writes finish before approved windows are destroyed. The native delegate's other methods remain intact. CI runs a macOS Objective-C runtime test for this termination method, plus the shared startup replay and frontend quit lifecycle tests.

Native installer creation, signing checks, and Rust tests are automated. Opening the installed macOS application, mixed-DPI window movement, and real tab drag/drop behavior require a macOS desktop for visual and interaction testing. See the [Tauri Actions guide](https://v2.tauri.app/distribute/pipelines/github/) and [GitHub's runner reference](https://docs.github.com/en/actions/how-tos/write-workflows/choose-where-workflows-run/choose-the-runner-for-a-job) for the upstream workflow and runner behavior.
