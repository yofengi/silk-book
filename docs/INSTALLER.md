# Installer notes

Boshu uses Tauri 2.12's NSIS bundler with a checked-in template at `src-tauri/installer/installer.nsi`. The template follows the `tauri-bundler` 2.7.0 template shipped with the Tauri 2.12 toolchain and keeps Tauri's normal install, upgrade, WebView2, shortcut, and uninstall flow. The only Boshu-specific UI is the file-association page at the end of the interactive install flow.

- The installer uses the default Tauri/MUI appearance. There are no custom sidebar or header bitmaps, palette overrides, DWM title-bar calls, or Mica calls.
- The association page has separate text, Markdown, and code groups. Text and Markdown are checked by default; code is unchecked and includes `lua`. The optional checkbox opens Windows Default Apps settings after registration.
- Silent (`/S`) and passive (`/P`) installs skip the page and register nothing. The page invokes `boshu.exe --register-assoc ...` only when the user leaves it.
- Uninstall invokes `boshu.exe --unregister-assoc all` before removing files. `src-tauri/nsis-hooks.nsh` keeps the ownership-checked registry cleanup as a fallback if the executable call fails.

## File icons

`src-tauri/icons/file-code.png` and `src-tauri/icons/file-text.png` remain the checked-in RGBA source images. `scripts/gen-file-icons.py` reproducibly writes `src-tauri/icons/file-code.ico` and `src-tauri/icons/file-text.ico` with 16, 20, 24, 32, 40, 48, 64, and 256 pixel entries. Run it in a throwaway virtual environment with `Pillow==11.3.0`:

```sh
python -m venv .tmp-file-icons
.tmp-file-icons/Scripts/python.exe -m pip install Pillow==11.3.0
.tmp-file-icons/Scripts/python.exe scripts/gen-file-icons.py
```

The two ICO files are bundle resources with install targets `icons/file-code.ico` and `icons/file-text.ico`, so an installed layout is:

```text
<install directory>\\boshu.exe
<install directory>\\icons\\file-code.ico
<install directory>\\icons\\file-text.ico
```

The CLI association mode runs before Tauri app creation and resolves these paths from `current_exe().parent()`. If a resource is absent, the registry `DefaultIcon` falls back to icon index 0 in the executable.

Associations keep the existing per-extension ProgID scheme (`Boshu.<ext>`) for IPC and upgrade compatibility. Code extensions use `file-code.ico`; text and Markdown extensions use `file-text.ico`. Unregistering checks the open command before deleting entries and also removes legacy `Boshu.File`, `Boshu.Code`, and `Boshu.Text` entries owned by this executable.

## Updating Tauri

When updating Tauri or `tauri-bundler`, copy the new upstream `src/bundle/windows/nsis/installer.nsi` into `src-tauri/installer/installer.nsi`, then reapply only the marked association-page and CLI-hook blocks. Keep all Handlebars placeholders and upstream page/section structure unchanged. Run `pnpm tauri build` and inspect the generated `src-tauri/target/release/nsis` script before committing.
