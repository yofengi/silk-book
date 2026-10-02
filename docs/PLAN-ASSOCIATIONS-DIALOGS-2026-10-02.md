# Association retention and themed confirmation dialogs

**Goal:** Preserve the user's registered file types across keep-data uninstall/reinstall, and render application confirmations using the active Boshu theme.

**Architecture:** Store the selected extension set separately from transient Windows registry registrations. Reinstall restores that set; uninstall removes registrations owned by that installation while retaining the set unless app data is explicitly deleted. Application confirmations use one queued HTML modal dialog service through the existing IPC facade; AbortSignal cancels stale lifecycle confirmations. System default-app choices remain controlled by Windows.

**Tech stack:** Tauri 2, Rust/winreg, NSIS, TypeScript, HTML dialog, shared CSS theme variables.

## Evidence and scope

- 0.2.0 app updates use `/S /UPDATE /R` and skip uninstall; this preserves existing association registry entries.
- Manual uninstall always executes the association removal hook, regardless of the keep-data checkbox. No selected-type snapshot currently exists to restore.
- The current `ipc.confirm` calls the native dialog plugin; its look does not follow application themes.
- Window close/install freezes the body with `inert`; a modal `showModal()` dialog must remain usable in the top layer, while editing and global commands remain blocked.
- Windows UserChoice is not rewritten. Once Windows has discarded a default-app choice, the user may need to select Boshu again in Windows settings.

## Ownership and work

### A1: Association persistence and installer integration

- [x] Add targeted failing regression coverage for remembered extension sets, empty sets, legacy registration capture, removal versus uninstall cleanup, and restore at a new installation path.
- [x] Implement validated, atomic persistence in the app data directory and restore only explicitly remembered or existing owned registrations.
- [x] Update association CLI, installer hooks, and app-data deletion handling. Preserve registrations during in-place updates; remove stale executable registrations during full uninstall.
- [x] Extend `scripts/qa-windows-installer.ps1` to verify registrations through upgrade and keep-data uninstall/reinstall on disposable CI runners only. Verify fresh silent installs register nothing and reset does not resurrect previous choices.
- [x] Run Rust tests and build the NSIS installer; never exercise real registry mutation/uninstall in the user's profile.

### A2: Theme-aware confirmation service

- [x] Implement shared `confirm(message, title?, options?: { signal?: AbortSignal })` for native and browser adapters, preserving the Promise<boolean> contract.
- [x] Use `<dialog>.showModal()` with textContent, theme colors/fonts/borders and glass surfaces, cancellation as initial focus, accessible labels, keyboard handling, and serialized requests.
- [x] Abort active or queued requests with false, restore focus when possible, and avoid stale handlers/elements.
- [x] Verify light/dark/glass/custom themes and four locales in a real browser, including body.inert, keyboard shortcuts, Escape, Tab, queued requests, and cancellation.

### A3: Window lifecycle integration

- [x] Attach an AbortController to each close attempt. Abort obsolete confirmations when another window cancels a quit/install vote.
- [x] Preserve local-close/global-quit merging, pending-file operation draining, edit freeze, and suppression of stale votes.
- [x] Add cancellation-during-pending-confirmation and cancellation-during-file-drain regressions, then run the existing lifecycle/freeze/file-drain suite.

### Main: Integration and release

- [x] Review agent changes against the two reported issues and make the Windows registration/default-app distinction explicit in user-facing documentation.
- [x] Run TypeScript, ESLint, four-locale checks, focused regressions, Rust/clippy, and native theme-confirmation checks with disposable configuration.
- [x] Version as 0.2.1, build signed Windows and macOS artifacts through CI, verify signatures/checksums and draft assets, then publish the complete release under the existing authorization.
- [x] Keep keys and QA artifacts out of Git. Preserve user documents, installed app, and current windows during local testing.

## Verification evidence

- Rust: 83 tests passed; Clippy with warnings denied passed.
- Frontend: TypeScript, full ESLint, four locales (342 keys) passed; focused dialog/update/file/lifecycle suite 65 tests plus window flows (13) and freeze checks (7) passed.
- Browser: 14 integration cases passed, including four theme modes, custom theme/font, four locales, keyboard/IME, queued/aborted dialogs and legacy WebKit API fallback; no system dialogs or page errors.
- Native Windows: 7 isolated-client cases passed, including real top-layer dialogs with inert editors and two-window quit cancellation. QA build SHA256: f65576f96e8945a9038de045e089d6f735622d29ffd8bafe9dc30e7d027d6a95.
- Independent review: stale legacy snapshot and unsafe missing-executable cleanup issues were fixed; no remaining release blocker found.
- Installer CI run 37005695845 passed Windows, macOS ARM64, macOS Intel, and signed-feed/checksum jobs at source f69355c90f414fabcc4b93fa8bb992acffb409a4. Windows exercised silent fresh install, updater restart, saved subset reconciliation, moved-path reinstall, explicit empty selection, real 0.2.0 migration, and settings/document preservation. Data-deletion coverage calls the fixed-path CLI; it does not click the NSIS checkbox. Actual minimum macOS WebKit behavior is simulated in browser fallback checks.

- Published https://github.com/yofengi/silk-book/releases/tag/v0.2.1 (release 401790742). All 9 checksums, 3 version-bound signatures, 10 uploaded GitHub asset sizes/digests, and the public latest update feed passed independent verification. The tag points to the tested source commit above. The first large artifact download ended early; a four-range retry verified the complete CI archive digest before extraction.
