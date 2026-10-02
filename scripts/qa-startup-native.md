# Native startup acceptance

Run from the repository in the actual Windows desktop user session. The harness refuses any pre-existing `boshu` process or listener on port 9223. It writes only a fresh `artifacts/qa-startup-*` profile, starts a Win32 observer before launching its own PID, and closes that PID gracefully; it does not install, terminate user processes, or touch the user's settings.

```powershell
$env:QA_PLAYWRIGHT = 'C:/path/to/playwright'
node scripts/qa-startup-native.mjs --baseline
node scripts/qa-startup-native.mjs
```

The baseline binary is `artifacts/previous-v0.1.0/boshu.exe`; the fixed binary is `src-tauri/target/release/boshu.exe`. Override `QA_EXECUTABLE` and `QA_APP_VERSION` together to test another binary. The result includes the executable's SHA-256 and actual IPC version rather than deriving identity from the package version alone.

The default cases are fresh 1000×700 and remembered 916×612. The full matrix adds remembered maximized, disabled memory with a saved 916×612, and an additional native window in every non-maximized case:

```powershell
$env:QA_STARTUP_CASES = 'normal,remembered,maximized,memory-off'
$env:QA_STARTUP_NEW_WINDOW = '1'
node scripts/qa-startup-native.mjs
```

`native.jsonl` records real `IsWindowVisible`, DPI, outer/client dimensions, position, and maximized state approximately every 5 ms. `summary.json` correlates those samples with persisted `startup:ui-ready` and `startup:window-shown` marks and FCP, so a late CDP connection cannot move the ready timestamp. The complete UI is sampled after `window-shown` and a further 1.2 seconds; native geometry must remain unchanged for the first visible second and the first visible client size must already be correct. A ready mark within the preceding-to-first-visible native sample interval is reported with that sampling uncertainty. The baseline has no startup marks: an early observed DOM transition or first contentful paint supplies evidence; a late connection to an already-ready UI is explicitly inconclusive. Baseline completion exits zero even when the defect is reproduced; fixed runs exit nonzero on failure.

For actual tab tear-out and merge acceptance, set `QA_STARTUP_CASES=remembered`, `QA_STARTUP_NEW_WINDOW=1`, and `QA_STARTUP_TEAROUT=1`. The harness opens a clean UTF-8 fixture in its own profile, keeps a blank source tab, then uses `native-window-qa.ps1 -Action Drag` for both gestures. That helper verifies the owned source HWND before sending mouse input. It checks text, path, clean state, selected text, unique source/target tab counts, target readiness/geometry, successful merge, closure of the empty detached window, and unchanged fixture bytes. Run this scenario in an otherwise idle desktop session because it moves the real pointer; the helper restores the pointer afterward.
