# Startup tabs and external file drops

**Goal:** Start with a saveable untitled document and open dropped files at the requested tab position.

**Architecture:** Keep the shared editor state attached to a document whenever startup permits editing. Route native file drops through the command and file-operation layers. Capture a tab anchor before reading files and recheck empty-tab eligibility before replacing content.

**Behavior:** Body drops reuse only an unmodified, empty, untitled tab; otherwise insert after the active tab. Tab-bar drops use a visible insertion marker. Batch order is preserved, existing paths are deduplicated, and explicit drops stay in the target window. Failed reads and edits during reads never remove user content. Startup files and transferred tabs do not leave a redundant blank tab.

## Work

- [x] A1: Extend file-opening options and tab placement/reuse; add regressions for dirty/empty/saved tabs, batch ordering, failures and concurrent edits.
- [x] A2: Add native drag/drop IPC and a themed tab insertion marker with edge scrolling; preserve existing internal tab dragging; test DPI, cancellation and modal/quit blocking.
- [x] A3: Create the startup document at the right lifecycle point; keep startup files/transfers and cancelled quit working; prevent editing an orphan placeholder; add startup regressions.
- [x] Main: Integrate interfaces, independently review changes, run TypeScript/lint and affected regression suites, and validate startup/save in an isolated native app.
- [x] Main: Build and publish the updated application through the release workflow after verification.

## Ownership

- A1: `src/editor/files.ts`, `src/editor/tabs.ts`, `src/editor/commands.ts`, focused file-open tests.
- A2: `src/ui/file-drop.ts`, its styles, `src/ipc/types.ts`, `src/ipc/tauri.ts`, `src/ipc/mock.ts`, `src/ui/index.ts`, focused drop tests.
- A3: `src/main.ts`, `src/core/startup.ts` if needed, `src/editor/view.ts` if needed, `scripts/test-startup.mjs`.
- Main: integration, QA, CI and version/release files.

New code comments follow the user's concise, single-line comment rules. No local installer or registry mutation is part of QA.

## Verification

- Source: `4aa12b8420ec10907d08d673afabcf532316571c`.
- TypeScript, full ESLint, four locales (342 keys each), and all 161 frontend regression tests passed. The first CI run exposed missing exports in the older file harness; the fixture was updated without changing its assertions or product code.
- The new file-open, native event adapter, and insertion-marker suites contain 26 cases. They cover empty/dirty/saved tabs, existing paths, batch order, stable anchors, concurrent reads and edits, Save As cancellation, failed reads, command freezing, modal blocking, DPI conversion, and edge scrolling.
- An isolated Windows executable using `com.boshu.editor.file-drop-qa`, its own settings/WebView/cache directories, and the glass-dark theme displayed an Untitled tab at startup. Typing and Ctrl+S wrote `Startup save QA 0.2.2` to the intended disposable fixture, verified from disk. Ctrl+N created another usable blank tab. The application logged `Boshu startup ready: main` and closed normally.
- Real Explorer-to-application dragging was not completed: Computer Use rejects drag endpoints outside the source window bounds. Native event handling and document placement are covered by the automated suites; actual mouse drag/drop and mixed-DPI behavior remain manual desktop checks.
- CI run `39187741672` passed on Windows x64, macOS Apple Silicon, and macOS Intel, including Rust tests, the disposable Windows installation/update/reinstall checks, and packaged macOS startup checks.
- Artifact `12159660415` belongs to that exact run and source. The 187,093,768-byte archive SHA-256 is `8718de77c45d516a5424de95eeb0f90c8b68672b430e65652bd428aa29f3e8af`. Independent verification passed for all nine checksums, three version-bound update signatures, and the update manifest's version, notes, and platform list.
- Published [v0.2.2](https://github.com/yofengi/silk-book/releases/tag/v0.2.2), release `416844263`. All ten public asset sizes/digests match the verified build, and the tag points to `4aa12b8420ec10907d08d673afabcf532316571c`. The public latest feed SHA-256 is `84698701e5b6d421fb4f7a34f1e4ed3691d3653cfd4bf70fc63b302ed91ff945` and matches the verified manifest exactly.
- Slow local uploads were replaced by the verified draft-upload workflow. Run `39191837250` succeeded after five failed local upload placeholders were individually checked and removed; completed assets were preserved. Query the dedicated release-assets endpoint when checking incomplete uploads, as the release object's embedded list omits `starter` entries. The duplicate tag build `39192338399` was cancelled after publication verification.
