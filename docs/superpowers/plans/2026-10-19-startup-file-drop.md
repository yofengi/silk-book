# Startup tabs and external file drops

**Goal:** Start with a saveable untitled document and open dropped files at the requested tab position.

**Architecture:** Keep the shared editor state attached to a document whenever startup permits editing. Route native file drops through the command and file-operation layers. Capture a tab anchor before reading files and recheck empty-tab eligibility before replacing content.

**Behavior:** Body drops reuse only an unmodified, empty, untitled tab; otherwise insert after the active tab. Tab-bar drops use a visible insertion marker. Batch order is preserved, existing paths are deduplicated, and explicit drops stay in the target window. Failed reads and edits during reads never remove user content. Startup files and transferred tabs do not leave a redundant blank tab.

## Work

- [x] A1: Extend file-opening options and tab placement/reuse; add regressions for dirty/empty/saved tabs, batch ordering, failures and concurrent edits.
- [x] A2: Add native drag/drop IPC and a themed tab insertion marker with edge scrolling; preserve existing internal tab dragging; test DPI, cancellation and modal/quit blocking.
- [x] A3: Create the startup document at the right lifecycle point; keep startup files/transfers and cancelled quit working; prevent editing an orphan placeholder; add startup regressions.
- [ ] Main: Integrate interfaces, review changes, run TypeScript/lint and affected regression suites, and validate startup/save/drop behavior in a running app.
- [ ] Main: Build and deliver the updated application through the existing release workflow after verification.

## Ownership

- A1: `src/editor/files.ts`, `src/editor/tabs.ts`, `src/editor/commands.ts`, focused file-open tests.
- A2: `src/ui/file-drop.ts`, its styles, `src/ipc/types.ts`, `src/ipc/tauri.ts`, `src/ipc/mock.ts`, `src/ui/index.ts`, focused drop tests.
- A3: `src/main.ts`, `src/core/startup.ts` if needed, `src/editor/view.ts` if needed, `scripts/test-startup.mjs`.
- Main: integration, QA, CI and version/release files.

New code comments follow the user's concise, single-line comment rules. No local installer or registry mutation is part of QA.
