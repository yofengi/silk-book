# Boshu IPC contract

## v0.2 changes

The v0.2 backend adds `CR` EOL support, system ANSI encoding, malformed-decoding metadata, spell checking, locale discovery, locked settings patches, multi-window initialization, acknowledged raw tab transfers, and focused-window file-open routing. `window_init` replaces the removed `initial_open_files` command. The exact TypeScript-facing signatures are below.

```ts
import { Channel, invoke } from '@tauri-apps/api/core';

type Eol = 'LF' | 'CRLF' | 'CR' | 'MIXED';
type AppError = {
  kind: 'io' | 'json' | 'invalidArgument' | 'encoding' | 'unmappable' |
    'unsupported' | 'cancelled' | 'channel';
  message: string;
};
type FileStat = { size: number; mtime: number; readonly: boolean };
type ReadMetadata = {
  encoding: string;
  eol: Eol;
  hasBom: boolean;
  size: number;
  malformed: boolean;
  eolMap?: string; // MIXED only; C=CRLF, L=LF, R=CR
};
type Progress = { kind: 'progress'; requestId: string; bytesRead: number; totalBytes: number };
type ReadDone = { kind: 'done'; requestId: string };
type ReadMessage = ArrayBuffer | Progress | ReadDone;
type WriteResult = { bytesWritten: number };
type EncodingInfo = { id: string; label: string; group: string; bom: boolean };
type AnsiEncoding = { codePage: number; id: string };
type SettingsPatch = { set?: Record<string, unknown>; remove?: string[] };
type SettingsSnapshot = { value: Record<string, unknown>; revision: number };
type SettingsChanged = SettingsSnapshot & { source: string };
type WindowOpenOptions = {
  files?: string[];
  transferToken?: string;
  x?: number;
  y?: number;
};
type WindowInit = { files: string[]; transferToken?: string };
type TransferStatus = { state: 'pending' | 'taken' | 'accepted' | 'missing'; target?: string };
type TransferPlacement = { index: number; beforeId?: string };
type TransferOffer = { token: string; source: string; placement?: TransferPlacement };
type QuitRequest = { requestId: string };
```

## Commands

| Command | Arguments | Resolves to | Notes |
|---|---|---|---|
| `file_stat` | `{ path: string }` | `FileStat` | Absolute path; size is bytes and mtime is Unix milliseconds. |
| `read_file` | `{ path, requestId, channel, encoding? }` | `ReadMetadata` | `encoding` defaults to `auto`; accepted values are `auto`, `utf-8`, `ansi`, or an `id` returned by `list_encodings`. BOM always wins. Data chunks are normalized UTF-8 with `\n`. `malformed` is true when the selected decoder substituted malformed input. |
| `cancel_read` | `{ requestId }` | `boolean` | Flags an active read. |
| `write_file` | raw `Uint8Array` plus headers | `WriteResult` | Body is `[ASCII eolMap prefix][UTF-8 normalized text]`. `x-boshu-allow-lossy: true` permits `?` replacement. No HTML NCRs are emitted. |
| `list_encodings` | none | `EncodingInfo[]` | Includes Unicode, ANSI, GBK, GB18030, Big5, Shift_JIS, EUC-JP, EUC-KR, and supported Windows-125x codecs. |
| `ansi_encoding` | none | `AnsiEncoding` | Uses Windows `GetACP`; unsupported ACPs reject with `kind: 'unsupported'`. |
| `spell_check` | `{ words: string[] }` | `string[]` | Windows Spell Checking API, `en-US`; max 2000 words, max 64 characters per word. Runs on one long-lived COM worker thread (MTA, never torn down while the checker is alive). Rejects with `unsupported` when the API/en-US provider is unavailable, the worker has stopped, or the provider does not answer within 2 s. |
| `system_locale` | none | `string` | Preferred Windows UI BCP-47 language, for example `zh-CN`. |
| `read_settings` | none | JSON value | Returns `{}` when settings are missing. |
| `write_settings` | `{ settingsValue: unknown }` | `void` | Legacy opaque replacement API. Uses the same lock/revision/broadcast as `settings_patch`; frontend edits use patches. |
| `settings_patch` | `SettingsPatch` | `SettingsSnapshot` | Read, merge/remove, write, revision allocation, and broadcast are guarded by one backend mutex. Broadcasts `settings-changed` to all windows with `source` set to the calling window label. |
| `window_open` | `{ opts: WindowOpenOptions }` | `string` | Async command creates `win-<n>` using the main window config. A transfer token is bound to exactly one recipient. Failed builds clear staged data and receipts. |
| `window_drop_target` | `{ x: number, y: number }` | `string \| null` | Signed 32-bit screen physical coordinates. On Windows, `WindowFromPoint` and `GetAncestor(GA_ROOT)` identify the actual topmost native window at this point, regardless of pointer capture. Returns its Boshu label, or `null` for desktop/other applications. Non-Windows and browser mock return `null`. |
| `window_init` | none | `WindowInit` | Call once per window after file-open/quit/transfer event subscriptions. `main` receives launch argv files; other windows receive the staged payload. Files arriving before initialization are appended to this payload. Each payload is consumed once. |
| `tab_transfer_put` | raw `Uint8Array` body | `string` | Backend does not parse body. Token belongs to the calling source, with 256 MiB total buffered bytes and 60-second expiry. |
| `tab_transfer_take` | `{ token: string }` | `ArrayBuffer` | Only the bound recipient may take once. Releases body bytes but retains the pending receipt; taking is not acknowledgement. |
| `tab_transfer_send` | `{ token: string, target: string, placement?: TransferPlacement }` | `void` | Only the token's source can bind it once to another, existing, initialized window. Rejects during an app quit vote. Emits `tab-transfer-offered` to that recipient; emission failure clears the binding/data. `placement.index` is a nonnegative insertion slot, with optional neighbour `beforeId`. |
| `tab_transfer_accept` | `{ token: string }` | `void` | Only the recipient may acknowledge after restoring the editor, document metadata, language, and selection. |
| `tab_transfer_status` | `{ token: string }` | `TransferStatus` | Only the source may query. A closed destination or expired token returns `missing`. Source removal requires `accepted` for the expected destination and an unchanged source snapshot. |
| `tab_transfer_cancel` | `{ token: string }` | `void` | Only the source may cancel/release its buffered data or receipt; already removed tokens are harmless. |
| `tab_transfer_reject` | `{ token: string }` | `void` | Only the bound recipient may reject/release the offer. Already removed tokens are harmless. The source then observes `missing` and retains its document. |
| `app_request_quit` | none | `void` | Starts one quit vote and broadcasts `quit-requested {requestId}`. Windows still being built are included. |
| `app_quit_reply` | `{ requestId: string, allow: boolean }` | `void` | One reply per participant; any refusal emits `quit-cancelled`. Only unanimous approval emits `quit-approved`. Stale or duplicate replies are ignored. |
| `allow_asset_dir` | `{ path: string }` | `void` | Existing asset-scope command. |
| `os_build` | none | `number` | Windows build number. |
| `bundled_fonts` | none | `BundledFont[]` | Existing resource command. |
| `list_system_fonts` | none | `string[]` | Existing blocking font enumeration command. |
| `file_assoc_status` | `{ exts: string[] }` | `FileAssocStatus[]` | Existing association command. |
| `file_assoc_register` | `{ exts: string[] }` | `void` | Existing association command. |
| `file_assoc_unregister` | `{ exts: string[] }` | `void` | Existing association command. |
| `open_default_apps_settings` | none | `void` | Existing command. |
| `themes_list` | none | `ThemeEntry[]` | Existing theme command. |
| `theme_import` | `{ sourcePath: string }` | `ImportedTheme` | Existing theme command. |
| `theme_delete` | `{ id: string }` | `void` | Existing theme command. |

## Events

- `open-files`: `string[]`, emitted only to the most recently focused window. The frontend decides whether to open in the current or a new window according to `window.openFilesInNewWindow`.
- `settings-changed`: `SettingsChanged`, emitted to all windows after `settings_patch` commits.
- `tab-transfer-offered`: `TransferOffer`, emitted only to the bound existing recipient by `tab_transfer_send`. Install `installIncomingTransferListener()` before `window_init`. The recipient rejects offers while closing or while the command gate is blocked.
- `quit-requested`: `QuitRequest`, emitted to all windows by `app_request_quit`; still-initializing windows receive the same request in `window_init`.
- `quit-approved`: `QuitRequest`, emitted after all participating windows approve. A window destroys itself only if it approved this exact request.
- `quit-cancelled`: `QuitRequest`, emitted when any window refuses or closes during a pending vote. Windows release their editing/transfer gate.

Settings revisions increase within one application process. Both patch replies and broadcasts carry the committed revision, so a late reply/event cannot replace a newer snapshot. The frontend subscribes before its initial read, serializes patches from each window, preserves pending keys while applying remote snapshots, and retains failed patches for retry. `flushSettings()` waits for pending writes and rejects on failure so window-close flows can preserve the unsaved choices.

Tab payloads are `[u32 little-endian UTF-8 header length][JSON header][UTF-8 text]`. Version 1 headers contain document metadata, per-tab flags, language id, and selection/scroll anchors. The 256 MiB limit applies to the entire body, including mixed-EOL maps. Undo history is intentionally not transferred. Failed, cancelled, closed, or expired transfers leave the source document intact; editing during transfer also retains the changed source. Recipient tab closing and further movement are disabled while initialization is in flight.

Dragging uses captured client coordinates and the source window's physical inner origin/scale to construct a screen point. The actual top-level HWND decides which window is under the point; being inside the source's client-coordinate rectangle does not by itself identify the source window. For another Boshu window, the frontend uses targeted `WindowBus` events:

| Event | Payload | Purpose |
|---|---|---|
| `tab-drop-probe` | `{ requestId, source, x, y, session? }` | Physical screen point. The target converts it with its own inner origin/scale, checks that its tab bar is visible at this point, and returns an insertion slot. A hover `session` also shows an insertion marker and allows edge scrolling. |
| `tab-drop-reply` | `{ requestId, target, placement?, blocked? }` | Reply only to the source. `placement` means a tab-bar hit; `blocked` means closing/quit interaction is frozen. The source matches the request and target; a failed or missing reply preserves the source without opening another window. |
| `tab-drop-clear` | `{ source, session }` | Clears that drag's foreign insertion marker on cancellation, release, or departure. |

On a valid foreign tab-bar drop, `tab_transfer_send` binds the opaque payload to that existing window. The recipient creates an independent tab even if the same path is already open, completes language loading, inserts before `beforeId` if that neighbour still exists (otherwise clamps `index`), activates it, restores selection/scroll, and only then acknowledges. Existing dirty tabs are never replaced. Own-window releases keep sorting; drops outside the source on desktop or outside another window's tab bar create a new window through `window_open`.

The new-window file preference sends each selected file to a separate window. Initialization opens the first staged file locally, then applies the preference to any additional files, preventing recursive forwarding or an empty launch window. Closing freezes edits and new transfers, settles active transfers, confirms all dirty documents, and flushes settings before destruction. A failed settings write keeps the window alive.

## Read and write protocol

`read_file` streams raw `ArrayBuffer` chunks through the supplied `Channel`. Chunks are valid UTF-8, character-aligned, normalized to `\n`, and at most 4 MiB. Progress messages use the same channel. The final `done` message is queued before the invoke promise resolves. Callers must wait for both the metadata promise and `done`; on cancellation or channel failure, discard chunks already received.

Detection samples up to 64 KiB. BOM wins for UTF-8/UTF-16LE/UTF-16BE. Without a BOM, valid UTF-8 wins, otherwise `chardetng` guesses. A forced encoding override bypasses guessing but not BOM precedence. `CRLF`, `LF`, and lone `CR` normalize to `\n`; a mixed document preserves one map character per source newline: `C`, `L`, or `R`. A document containing only one EOL kind reports `LF`, `CRLF`, or `CR`; mixed documents report `MIXED` and include `eolMap`.

Call `invoke('write_file', body, { headers })`, not an object containing `body`. Headers are ASCII and case-insensitive:

| Header | Required | Value |
|---|---|---|
| `x-boshu-path` | yes | `encodeURIComponent` of absolute path |
| `x-boshu-encoding` | yes | Encoding id/label, including `ansi` |
| `x-boshu-eol` | yes | `LF`, `CRLF`, `CR`, or `MIXED` |
| `x-boshu-bom` | yes | `true` or `false`; BOM applies to UTF-8/UTF-16 |
| `x-boshu-eol-map-length` | for `MIXED` | Decimal ASCII prefix length in bytes |
| `x-boshu-allow-lossy` | optional | `true` replaces unrepresentable characters with `?`; default rejects |

For `MIXED`, the raw body starts with the ASCII `eolMap` prefix, followed by `TextEncoder().encode(normalizedText)`. For other EOL modes, the body is only normalized text. UTF-16LE/BE is encoded manually with an optional BOM. All other codecs use `encoding_rs`. Unrepresentable text rejects with `{ kind: 'unmappable', message }`, including a count and first character in the message.

All command failures reject with a serializable `AppError`; do not assume an `Error` instance. `io`, `json`, `invalidArgument`, `encoding`, `unmappable`, `unsupported`, `cancelled`, and `channel` identify backend failure classes.

## Capabilities and window behavior

The main capability applies to `main` and `win-*`, and grants the existing window controls plus `opener:allow-reveal-item-in-dir`. No webview-create permission is needed because new windows are created by the Rust `window_open` command. Windows are decorationless, transparent, shadowed, with a default minimum inner size of 640 x 400; restored dimensions and minimums are clamped to the target monitor's work area. The last native window is allowed to terminate the app using Tauri's normal behavior.
