# Background update downloads and explicit installation

**Goal:** Download signed updates in the background, share progress across all windows, and install only after the user clicks and every window approves closing.

**Architecture:** Rust owns one download/cache/install state. The official Tauri 2 updater verifies packages and performs platform installation. About and the topbar subscribe to the same revisioned state. Existing GitHub release checking remains in place. Windows NSIS and macOS DMG installers remain available; macOS also gets signed app update archives.

## Agreed behavior

- `updates.autoDownload` is false by default. Automatic updates only download; they never install automatically.
- `updates.manualMode` defaults to `download-only`; alternative `download-and-install`.
- Both modes stop at ready. Download-and-install and automatic downloads show one completion popup; the user explicitly clicks Install and restart. Download-only exposes Install update in both surfaces without forcing the popup.
- About and topbar show real bytes and percentage, or an indeterminate indicator when the total is unknown. Closing the popup does not stop a download.
- Downloaded packages survive restart after signature verification. Incomplete/corrupt cache can be retried. Successful upgrades clean only app-owned updater files, never user Downloads.
- Installation collects the existing all-window dirty/flush confirmations and freezes edits and transfers. Cancellation or launch failure restores normal operation. No windows are destroyed before the installer can start.

## Shared contract

`UpdateInfo.transfer` is an `UpdateTransferState`. JSON fields:

```
revision: number
taskId: string | null
phase: idle | downloading | verifying | ready | preparingInstall | installing | error
release: ReleaseInfo | null
source: manual | automatic
mode: download-only | download-and-install
downloadedBytes: number
totalBytes: number | null
error: { kind: string, message: string } | null
```

Commands: `updates_download(version, mode)` returns the immediate shared snapshot; `updates_install(taskId)` requests installation; `updates_transfer()` returns the current snapshot. Event `updates-state-changed` carries the full snapshot. Targeted `updates-ready` carries `{ taskId, revision }` to the initiating window (or one focused available window). Frontends subscribe before reading snapshots and reject older revisions. The release in a transfer is pinned to that package even if another release is discovered.

`QuitRequest` gains optional `purpose: quit | installUpdate`. Rust `window::request_update_install(&AppHandle, task_id: String)` starts an installation vote, retaining its lifecycle guard after approval. It invokes async `update_transfer::install_approved(AppHandle, task_id)` only after every window agrees. Cancellation calls `update_transfer::cancel_install(&AppHandle, &str)`. Install failure leaves a retryable ready package and releases the vote/freeze. Frontend install votes do not destroy their windows.

## Ownership and sequence

1. A1 (6.1-sol high): Rust transfer/cache/updater, updates.rs integration, Cargo dependencies and lib registration, focused Rust tests. Do not edit window.rs or app config.
2. A2 (6.1-sol max): frontend update service, IPC types/adapters/mock, About/topbar/progress styles, settings and four translations, update/UI tests. Do not edit src/ui/window.ts or native code.
3. A3 (6.1-sol high): native installation-aware quit lifecycle in window.rs, src/ui/window.ts, lifecycle tests. Coordinate exact helper interfaces with A1/A2; do not edit their owned files.
4. Main: signing key provisioning/public configuration, signed artifact/feed CI and tests, release version/docs, integration and independent review, Windows native QA and three-platform release.

## Verification

- Download sharing, monotonic progress, safe retry, bad signature/corrupt cache rejection, restart restore and owned-cache cleanup.
- Both manual modes and automatic completion require user action; completed install buttons replace download/ignore.
- Dirty cancellation unfreezes every window; installer is never launched before all votes; new windows remain blocked during replacement.
- TypeScript/lint/i18n, Rust, update and lifecycle regressions, browser progress/popup/focus tests, native startup and update UI smoke checks.
- CI builds signed Windows x64 and macOS ARM64/x64 packages; validates manifest and signatures before release publication.
