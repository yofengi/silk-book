# Interaction motion and completion implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development and verification-before-completion for this continuation.

**Goal:** Hide the sole tab’s close button, exclude numeric completion, and add subtle animation to tabs and app surfaces.

**Architecture:** Keep keyed tab DOM nodes across metadata changes. Gate every completion source and its cached-result paths. Share bounded surface animation helpers while releasing interaction and focus synchronously.

**Tech stack:** TypeScript, CodeMirror 6, CSS, Web Animations, Tauri 2.

## Approved behavior

- Count file and settings tabs together; one tab hides X but keeps the dirty indicator and keyboard/middle-click close behavior.
- Pure numbers neither trigger completion nor appear as candidates. Identifiers such as `name2` remain eligible (confirmed by the user).
- Use short fades and small offsets for menus, dialogs, hints, search, and tab membership changes. Respect reduced motion. Typing and download progress must not restart animations.
- Close actions release input, modal state, and focus immediately. Outgoing visuals have no IDs, focusability, or pointer interaction.

## Work and verification

- [x] A1: implement keyed tab rendering in `src/ui/tab-renderer.ts` and bounded motion in `src/ui/tab-motion.ts` / `.css`; integrate in `src/ui/index.ts`. Add lifecycle tests in `scripts/test-tab-ui-motion.mjs`.
- [x] A2: wrap completion sources in `src/editor/completions/numeric.ts` / `src/editor/view.ts`. Cover numeric contexts, candidates, language completion, `validFor`, and `update` in `scripts/test-word-completion.mjs`.
- [x] A3: implement `src/ui/motion.ts` / `.css` and integrate menu, status bar, update panel, palette, confirmation, and progress surfaces. Check modal teardown and reopen races in `scripts/test-ui-motion.mjs`.
- [x] A2 follow-up: add delegated themed title hints in `src/ui/tooltips.ts` / `.css`; verify clean dismissal and title restoration in `scripts/test-tooltips.mjs`.
- [x] Root: integrate global style and hint initialization; inspect changes and independent review findings. Run TypeScript, ESLint, translation parity, all workflow regression scripts, and frontend production build.
- [x] Root: complete isolated native UI verification. The supported browser runtime is unavailable; reduced-motion paths are covered by automated lifecycle checks.
- [x] Root: update version and release notes for 0.2.3, add new regressions to CI, push verified source, and build Windows plus both macOS architectures.
- [x] Root: upload verified signed artifacts to a draft using `upload-release-assets.yml`, verify release assets/feed, and publish under existing authorization.

## Verification log

- All 200 frontend regression cases passed on the three CI platforms. TypeScript, full ESLint, four-locale parity and frontend build passed. Native Rust tests passed: Windows 83, macOS Apple Silicon 82, macOS Intel 82. The Windows installer migration and both packaged macOS startup checks passed.
- Independent reviews found one fast-dismiss geometry issue; the fix and regression case preserve the current visual position while releasing native modal state synchronously.
- Native Windows QA verified one-tab X suppression, dirty indicator, restored close buttons on a second tab, closing back to one tab, variable-name completion and numeric suppression, search/menu layering, themed confirmation cancellation and input release.
- Native QA found the default title tooltip returning after dismissal; suppression now lasts until the owner is left, with regression tests for hover, focus and dynamic title changes. The rebuilt native program passed the click-menu / Escape / pointer-remains reproduction. The temporary program exited normally after saving its test fixture.
- Release source: `f3c507e187817032e308430f04c278f1957430f2`. Build run `39223280471` and draft uploader `39225610203` both succeeded.
- Published [v0.2.3](https://github.com/yofengi/silk-book/releases/tag/v0.2.3), release ID `417066583`, with ten matching resources. Independently checked nine checksums, three version-bound updater signatures, asset sizes/digests, release notes and the source tag.
- The public latest update feed reports `0.2.3` and exactly matches the verified build: SHA-256 `7b226d00fc97dcb01f72b9c825bd0b3bafe7f8c9727d83b851c5152c225b3005`.
