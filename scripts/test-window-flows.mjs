// Regression checks for window lifecycle and draft ownership. No DOM runner needed.
/* global console, setTimeout, clearTimeout, TextEncoder, TextDecoder, process */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import ts from 'typescript';

const require = createRequire(import.meta.url);
function load(file, imports, globals = {}) {
  const module = { exports: {} };
  const code = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, {
    module, exports: module.exports,
    require: (name) => name in imports ? imports[name] : require(name),
    console, setTimeout, clearTimeout, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, DataView,
    ...globals,
  }, { filename: file });
  return module.exports;
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
function fixture() {
  const commands = new Map();
  const hooks = {};
  const calls = [];
  const root = { inert: false };
  let dirty = [];
  let approve = true;
  let failFlush = false;
  const ipc = {
    confirm: async () => { calls.push('confirm'); return approve; },
    requestQuit: async () => { calls.push('request-quit'); },
    replyQuit: async (requestId, allow) => { calls.push(['reply', requestId, allow]); },
    onQuitRequested: async (fn) => { hooks.quit = fn; },
    onQuitApproved: async (fn) => { hooks.approved = fn; },
    onQuitCancelled: async (fn) => { hooks.cancelled = fn; },
    window: {
      onCloseRequested: async (fn) => { hooks.close = fn; },
      close: async () => { calls.push('close'); },
      destroy: async () => { calls.push('destroy'); },
      minimize: async () => {}, toggleMaximize: async () => {},
    },
  };
  const module = load('src/ui/window.ts', {
    '../core/commands': {
      registerCommand: (cmd) => commands.set(cmd.id, cmd),
      isCommandExecutionBlocked: () => false, setCommandExecutionBlocked() {},
    },
    '../core/settings': { flushSettings: async () => { calls.push('flush'); if (failFlush) throw Error('disk full'); } },
    '../editor/document': { baseName: (path) => path ?? 'untitled' },
    '../editor/tabs': { listTabs: () => dirty },
    '../editor/transfer': {
      setTransferClosing() {},
      cancelOutgoingTransfers: async () => { calls.push('cancel-transfers'); },
    },
    '../i18n': { t: (key) => key },
    '../ipc': { ipc, errorMessage: (e) => e.message },
  }, { document: { getElementById: () => root, documentElement: { classList: { toggle() {} } } }, alert: (s) => calls.push(['alert', s]) });
  return {
    module, commands, calls, hooks, root,
    setDirty: () => { dirty = [{ doc: { path: null, dirty: true } }]; },
    setApprove: (value) => { approve = value; },
    failFlush: () => { failFlush = true; },
  };
}

const checks = [];
async function check(name, fn) {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (error) { checks.push(name); console.error(`FAIL ${name}: ${error.message}`); }
}

await check('ordinary browser import never dereferences a Tauri window', () => {
  let touches = 0;
  const tauri = load('src/ipc/tauri.ts', {
    '@tauri-apps/api/core': {}, '@tauri-apps/api/window': {},
    '@tauri-apps/api/webviewWindow': { getCurrentWebviewWindow: () => { touches++; throw Error('not in Tauri'); } },
    '@tauri-apps/api/event': {}, '@tauri-apps/plugin-opener': {}, '@tauri-apps/plugin-dialog': {},
    '../i18n': {}, './types': {},
  });
  assert.ok(tauri.tauriIpc);
  assert.equal(touches, 0);
});
await check('closing a clean window flushes pending settings before destroying', async () => {
  const f = fixture();
  f.module.registerWindowCommands();
  await f.module.windowLifecycleReady?.();
  let prevented = false;
  f.hooks.close({ preventDefault: () => { prevented = true; } });
  await tick();
  assert.equal(prevented, true);
  assert.ok(f.calls.indexOf('flush') >= 0);
  assert.ok(f.calls.indexOf('destroy') > f.calls.indexOf('flush'));
});
await check('failed settings flush retains the window and releases UI', async () => {
  const f = fixture(); f.failFlush();
  f.module.registerWindowCommands();
  await f.module.windowLifecycleReady?.();
  f.hooks.close({ preventDefault() {} });
  await tick();
  assert.equal(f.calls.includes('destroy'), false);
  assert.equal(f.root.inert, false);
});
await check('app quit requests a vote from every window', async () => {
  const f = fixture(); f.module.registerWindowCommands();
  await f.commands.get('app.quit').run({});
  assert.deepEqual(f.calls, ['request-quit']);
});
await check('duplicate close requests show only one dirty confirmation', async () => {
  const f = fixture(); f.setDirty(); f.setApprove(false); f.module.registerWindowCommands();
  await f.module.windowLifecycleReady?.();
  f.hooks.close({ preventDefault() {} });
  f.hooks.close({ preventDefault() {} });
  await tick();
  assert.equal(f.calls.filter((c) => c === 'confirm').length, 1);
  assert.equal(f.calls.includes('destroy'), false);
});
await check('one approved vote never destroys a window before all votes', async () => {
  const f = fixture(); f.module.registerWindowCommands();
  await f.module.windowLifecycleReady?.();
  await f.hooks.quit({ requestId: 'q1' });
  await tick();
  assert.equal(f.calls.includes('destroy'), false);
  assert.equal(f.root.inert, true);
  assert.ok(f.calls.some((c) => Array.isArray(c) && c[0] === 'reply' && c[1] === 'q1' && c[2] === true));
  await f.hooks.cancelled({ requestId: 'q1' });
  assert.equal(f.root.inert, false);
  assert.equal(f.calls.includes('destroy'), false);
});
await check('a dirty app quit cancellation keeps the window and allows another quit attempt', async () => {
  const f = fixture(); f.setDirty(); f.setApprove(false); f.module.registerWindowCommands();
  await f.module.windowLifecycleReady?.();
  for (const requestId of ['native-quit-1', 'native-quit-2']) {
    await f.hooks.quit({ requestId });
    await tick();
    assert.ok(f.calls.some((c) => Array.isArray(c) && c[0] === 'reply' && c[1] === requestId && c[2] === false));
    assert.equal(f.calls.includes('destroy'), false);
    assert.equal(f.root.inert, false);
  }
  assert.equal(f.calls.filter((c) => c === 'confirm').length, 2);
});
await check('app quit rejects a failed settings flush and retains the window', async () => {
  const f = fixture(); f.failFlush(); f.module.registerWindowCommands();
  await f.module.windowLifecycleReady?.();
  await f.hooks.quit({ requestId: 'native-flush-failed' });
  await tick();
  assert.ok(f.calls.some((c) => Array.isArray(c) && c[0] === 'reply' && c[2] === false));
  assert.equal(f.calls.includes('destroy'), false);
  assert.equal(f.root.inert, false);
});
await check('approved app quit destroys only after settings flush and the global approval', async () => {
  const f = fixture(); f.setDirty(); f.module.registerWindowCommands();
  await f.module.windowLifecycleReady?.();
  await f.hooks.quit({ requestId: 'native-approved' });
  await tick();
  assert.equal(f.calls.includes('destroy'), false);
  const reply = f.calls.findIndex((c) => Array.isArray(c) && c[0] === 'reply' && c[2] === true);
  assert.ok(reply > f.calls.indexOf('flush'));
  await f.hooks.approved({ requestId: 'native-approved' });
  await tick();
  assert.ok(f.calls.indexOf('destroy') > reply);
});
if (checks.length) process.exitCode = 1;
