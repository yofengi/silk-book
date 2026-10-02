# Installer notes

Boshu uses Tauri 2.12's NSIS bundler with a checked-in template at `src-tauri/installer/installer.nsi`. The template follows the `tauri-bundler` 2.7.0 template shipped with the Tauri 2.12 toolchain and keeps Tauri's normal install, upgrade, WebView2, shortcut, and uninstall flow. The only Boshu-specific UI is the file-association page at the end of the interactive install flow.

- The installer uses the default Tauri/MUI appearance. There are no custom sidebar or header bitmaps, palette overrides, DWM title-bar calls, or Mica calls.
- The association page has separate text, Markdown, and code groups. Text and Markdown are checked by default; code is unchecked and includes `lua`. The optional checkbox opens Windows Default Apps settings after registration.
- Silent (`/S`) and passive (`/P`) installs skip the page. A fresh unattended install with no remembered choices registers nothing; reinstall and upgrade restore only remembered types. Existing choices, including an explicitly empty set, bypass the default association page.
- The interactive page stores its exact selection with `boshu.exe --replace-assoc ...` (`none` for no types). Later registration and cancellation in application settings update the same selection.
- Uninstall checks whether the application is running before cleaning registrations, so cancelling that check does not first remove file associations. Its cleanup command preserves the remembered selection when retaining data.

## Keeping associations across reinstall

From 0.2.1, `%APPDATA%/Boshu/associations.json` stores the explicitly chosen extension set. Full uninstall removes registry entries owned by that installation, but keeping app data keeps this file. The post-install hook restores those types with commands and icons pointing at the final installation path. Choosing to delete app data also removes the actual `Boshu` data directory, not just Tauri's separate `com.boshu.editor` directory.

When an older installation still has registered types, the incoming installer uses its new executable as a headless snapshot helper before the old executable is replaced or uninstalled. The temporary migration record lives in the legacy Tauri data directory so an older uninstaller's Delete app data choice removes it. Registration is performed only by the final installed executable. Types already removed by an earlier uninstall, with no saved record, must be registered once again.

Registration controls the Open with list and Boshu's registered-type status. Windows owns the default application selection; the installer does not rewrite or bypass `UserChoice`.

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
