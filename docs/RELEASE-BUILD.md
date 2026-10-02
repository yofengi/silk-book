# Installer builds

`.github/workflows/build-installers.yml` builds installers on version tags (`v0.1.1`) or a manual Actions run. It has read-only repository permissions and does not create or publish a Release. Maintainers review and upload the resulting files after the build succeeds.

| Installer | Native runner | Rust target |
| --- | --- | --- |
| Windows x64 NSIS | `windows-2022` | `x86_64-pc-windows-msvc` |
| macOS Apple Silicon DMG | `macos-15` | `aarch64-apple-darwin` |
| macOS Intel DMG | `macos-15-intel` | `x86_64-apple-darwin` |

Each job runs the translation and window lifecycle checks, builds with the lockfiles, runs the Rust tests, then uploads its installer and SHA256 checksum. The final `silk-book-installers` artifact contains all three installers, individual `.sha256` files, and a verified `SHA256SUMS.txt`. Artifact retention is 30 days.

The release filenames are:

```text
silk-book-0.1.1-windows-x64-setup.exe
silk-book-0.1.1-macos-arm64.dmg
silk-book-0.1.1-macos-x64.dmg
SHA256SUMS.txt
```

`scripts/prepare-release-artifact.mjs` reads the version from `package.json` and `tauri.conf.json`, rejects mismatches and ambiguous or empty bundle output, copies the installer under its release filename, and generates its checksum. A tag-triggered run also requires the tag to match the version. The combined checksum step verifies the bytes of every installer against its checksum before writing the list.

## Local commands

Install the [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/), the pnpm version from `package.json`, Node.js 22, and Rust stable. Run macOS builds on macOS.

```sh
pnpm install --frozen-lockfile
rustup target add x86_64-pc-windows-msvc
pnpm tauri build --ci --target x86_64-pc-windows-msvc --bundles nsis -- --locked
node scripts/prepare-release-artifact.mjs windows-x64
```

```sh
rustup target add aarch64-apple-darwin
pnpm tauri build --ci --target aarch64-apple-darwin --bundles dmg -- --locked
cargo test --locked --manifest-path src-tauri/Cargo.toml --target aarch64-apple-darwin
node scripts/prepare-release-artifact.mjs macos-arm64
```

For Intel macOS, replace the target with `x86_64-apple-darwin` and the script argument with `macos-x64`. The staging script expects Tauri's target-specific output directory, so keep the explicit `--target` argument.

```sh
node --test scripts/prepare-release-artifact.test.mjs
```

## macOS configuration

Tauri automatically merges `src-tauri/tauri.macos.conf.json`. It enables the transparent-window API, bundles the existing icon as ICNS and PNG, uses a minimum macOS version of 11.0, and uses the ad-hoc signing identity `-`. No Apple certificate or notarization credentials are needed for this configuration. Ad-hoc signing is not Apple notarization; downloaded apps can require approval in Privacy & Security. See [Tauri's signing guide](https://v2.tauri.app/distribute/sign/macos/).

The Tauri CLI manages the required `macos-private-api` Cargo feature from this configuration. The CI therefore runs the native Rust tests after `tauri build`, so the Cargo manifest and merged configuration agree. Tauri removes the intermediate `.app` when only DMG output is requested, so CI mounts the finished DMG read-only, checks its embedded app with `codesign --verify --deep --strict`, and smoke-tests that executable with an isolated HOME before uploading. The startup check requires both an onscreen app window through Core Graphics and a successful frontend-ready confirmation, catching a process that remains hidden or only displays the startup failure fallback.

Settings, window state, and themes use `~/Library/Application Support/Boshu` on macOS. Windows keeps `%APPDATA%\Boshu`. macOS enumerates fonts through CoreText and uses AppKit's native frontmost window hit test for cross-window tab drops. Windows file associations and spell checking remain Windows-specific APIs.

The macOS application menu uses a regular Quit item with Cmd+Q, which starts the shared quit vote. Cocoa termination requests, including Dock Quit, are cancelled at `applicationShouldTerminate:` and routed through the same protocol. Dirty confirmation and pending settings writes finish before approved windows are destroyed. The native delegate's other methods remain intact. CI runs a macOS Objective-C runtime test for this termination method, plus the shared startup replay and frontend quit lifecycle tests.

Native installer creation, signing checks, and Rust tests are automated. Opening the installed macOS application, mixed-DPI window movement, and real tab drag/drop behavior require a macOS desktop for visual and interaction testing. See the [Tauri Actions guide](https://v2.tauri.app/distribute/pipelines/github/) and [GitHub's runner reference](https://docs.github.com/en/actions/how-tos/write-workflows/choose-where-workflows-run/choose-the-runner-for-a-job) for the upstream workflow and runner behavior.
