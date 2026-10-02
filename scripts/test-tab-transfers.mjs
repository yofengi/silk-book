// Exercise actual TS command/transfer logic with a controlled IPC transport.
/* global console, setTimeout, clearTimeout, TextEncoder, TextDecoder, process */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { Text } from '@codemirror/state';

const require = createRequire(import.meta.url);
function load(file, imports, globals = {}) {
  const module = { exports: {} };
  const code = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, {
    module, exports: module.exports,
    require: (name) => name in imports ? imports[name] : require(name),
    console: { warn() {}, error() {} },
    setTimeout: (fn) => setTimeout(fn, 0), clearTimeout,
    TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, DataView, ...globals,
  }, { filename: file });
  return module.exports;
}

function transferFixture() {
  const tab = {
    id: 'tab-1', state: { doc: Text.of(['中文 draft 🚀']) },
    doc: { path: null, encoding: 'UTF-16BE', eol: 'CR', hasBom: true, size: 20, tier: 'Normal', dirty: true },
    flags: { minimap: false, wordCompletion: true, lineWrap: false }, languageId: 'plaintext',
  };
  const tabs = [tab];
  const calls = []; let payload; let receipt = () => ({ state: 'accepted', target: 'win-1' });
  const ipc = {
    transferPut: async (bytes) => { payload = bytes; calls.push('put'); return 'token-1'; },
    windowOpen: async () => { calls.push('open'); return 'win-1'; },
    transferStatus: async () => { calls.push('status'); return receipt(); },
    transferCancel: async () => { calls.push('cancel'); },
    window: { close: async () => { calls.push('close-window'); } },
  };
  const module = load('src/editor/transfer.ts', {
    '../core/events': { events: { emit() {} } },
    '../core/commands': { isCommandExecutionBlocked: () => false },
    '../core/settings': { getSetting: () => false },
    '../i18n': { t: (key) => key },
    '../ipc': { ipc, errorMessage: (error) => error.message },
    './tabs': {
      listTabs: () => tabs, allTabIds: () => tabs.map((entry) => entry.id),
      tabText: (entry) => entry.state.doc.toString(),
      viewSnapshot: () => ({ anchor: 1, head: 4, scrollPos: 0 }),
      closeTab: (id) => { calls.push('remove-source'); tabs.splice(tabs.findIndex((entry) => entry.id === id), 1); },
    },
  }, { alert: () => calls.push('alert') });
  return { module, ipc, tab, tabs, calls, setReceipt: (fn) => { receipt = fn; }, payload: () => payload };
}

const failures = [];
async function check(name, fn) {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message}`); }
}

await check('pending/taken payload delivery never removes source before acceptance', async () => {
  const f = transferFixture(); let queries = 0;
  f.setReceipt(() => {
    assert.equal(f.tabs.length, 1);
    return { state: ['pending', 'taken', 'accepted'][queries++], target: 'win-1' };
  });
  assert.equal(await f.module.moveTabToNewWindow('tab-1'), true);
  assert.equal(queries, 3);
  assert.equal(f.tabs.length, 0);
});
await check('failed window creation keeps unsaved text and frees transfer token', async () => {
  const f = transferFixture();
  f.ipc.windowOpen = async () => { throw Error('cannot create window'); };
  assert.equal(await f.module.moveTabToNewWindow('tab-1'), false);
  assert.equal(f.tabs[0].state.doc.toString(), '中文 draft 🚀');
  assert.ok(f.calls.includes('cancel'));
  assert.equal(f.calls.includes('remove-source'), false);
});
await check('closed or expired recipient keeps source even after payload was taken', async () => {
  const f = transferFixture(); f.setReceipt(() => ({ state: 'missing' }));
  assert.equal(await f.module.moveTabToNewWindow('tab-1'), false);
  assert.equal(f.tabs.length, 1);
});
await check('editing source while destination loads preserves the new draft', async () => {
  const f = transferFixture();
  f.setReceipt(() => {
    f.tab.state.doc = Text.of(['edited while loading']);
    return { state: 'accepted', target: 'win-1' };
  });
  assert.equal(await f.module.moveTabToNewWindow('tab-1'), true);
  assert.equal(f.tabs[0].state.doc.toString(), 'edited while loading');
});
await check('changing source metadata while destination loads preserves it', async () => {
  const f = transferFixture();
  f.setReceipt(() => { f.tab.doc.eol = 'LF'; return { state: 'accepted', target: 'win-1' }; });
  assert.equal(await f.module.moveTabToNewWindow('tab-1'), true);
  assert.equal(f.tabs[0].doc.eol, 'LF');
});
await check('cancelling while window creation is in flight never deletes source', async () => {
  const f = transferFixture();
  f.ipc.windowOpen = async () => { await f.module.cancelOutgoingTransfers(); return 'win-1'; };
  assert.equal(await f.module.moveTabToNewWindow('tab-1'), false);
  assert.equal(f.tabs.length, 1);
  assert.equal(f.calls.includes('remove-source'), false);
});
await check('ordinary mixed-EOL text may have metadata larger than one MiB', async () => {
  const f = transferFixture();
  f.tab.state.doc = Text.of('a\n'.repeat(1_048_576).split('\n'));
  f.tab.doc.eol = 'MIXED'; f.tab.doc.eolMap = 'CL'.repeat(524_288);
  assert.equal(await f.module.moveTabToNewWindow('tab-1'), true);
  assert.ok(f.payload().length < 4 * 1024 * 1024);
  assert.ok(new DataView(f.payload().buffer).getUint32(0, true) > 1024 * 1024);
});

function openFixture() {
  const commands = new Map(); const windows = []; const local = []; let newWindows = true;
  const ipc = { windowOpen: async (opts) => { windows.push(opts); return `win-${windows.length}`; } };
  load('src/editor/commands.ts', {
    '../core/commands': { registerCommand: (command) => commands.set(command.id, command) },
    '../core/keybindings': { registerKeybinding() {} },
    '../core/settings': { getSetting: (key) => key === 'window.openFilesInNewWindow' ? newWindows : false },
    '../i18n': { t: (key) => key }, '../ipc': { ipc },
    './document': {}, './files': { openPath: async (path) => local.push(path) },
    './encodings': {}, './languages': {}, '../ui/palette': {}, './tabs': {}, './transfer': {},
  }).registerEditorCommands();
  return { commands, ipc, windows, local, disablePreference: () => { newWindows = false; } };
}
await check('new-window preference opens each selected file in its own window', async () => {
  const f = openFixture();
  await f.commands.get('file.open').run({}, { paths: ['C:\\one.txt', 'C:\\two.txt'] });
  assert.deepEqual(f.windows.map((opts) => opts.files.join('|')), ['C:\\one.txt', 'C:\\two.txt']);
  assert.equal(f.local.length, 0);
});
await check('failure falls back only the failed file and continues opening others', async () => {
  const f = openFixture(); let count = 0;
  const open = f.ipc.windowOpen;
  f.ipc.windowOpen = async (opts) => { if (++count === 2) throw Error('failed'); return open(opts); };
  await f.commands.get('file.open').run({}, { paths: ['one', 'two', 'three'] });
  assert.deepEqual(f.local, ['two']);
  assert.deepEqual(f.windows.map((opts) => opts.files.join('|')), ['one', 'three']);
});
await check('initialization here flag prevents forwarding a staged file again', async () => {
  const f = openFixture();
  await f.commands.get('file.open').run({}, { paths: ['staged'], here: true });
  assert.deepEqual(f.local, ['staged']); assert.equal(f.windows.length, 0);
  f.disablePreference();
  await f.commands.get('file.open').run({}, { paths: ['local-1', 'local-2'] });
  assert.deepEqual(f.local, ['staged', 'local-1', 'local-2']);
});
if (failures.length) process.exitCode = 1;
