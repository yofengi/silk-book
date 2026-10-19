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
- [ ] Root: complete isolated native UI verification. The supported browser runtime is unavailable; reduced-motion paths are covered by automated lifecycle checks.
- [ ] Root: update version and release notes for 0.2.3, add new regressions to CI, push verified source, and build Windows plus both macOS architectures.
- [ ] Root: upload verified signed artifacts to a draft using `upload-release-assets.yml`, verify release assets/feed, and publish under existing authorization.

## Verification log

- Full workflow regression set passed (197 cases); final geometry and tooltip fixes add three passing cases, bringing coverage to 200. TypeScript, full ESLint, four-locale parity and frontend build passed.
- Independent reviews found one fast-dismiss geometry issue; the fix and regression case preserve the current visual position while releasing native modal state synchronously.
- Native Windows QA verified one-tab X suppression, dirty indicator, restored close buttons on a second tab, closing back to one tab, variable-name completion and numeric suppression, search/menu layering, themed confirmation cancellation and input release.
- Native QA found the default title tooltip returning after dismissal; suppression now lasts until the owner is left, with regression tests for hover, focus and dynamic title changes. Final rebuilt native check is pending.
