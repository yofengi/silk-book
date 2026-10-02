// Real command, keyboard, palette, and lifecycle modules share one quit gate.
/* global console, setTimeout, clearTimeout, TextEncoder, TextDecoder, Event, EventTarget, process */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import ts from 'typescript';

const require = createRequire(import.meta.url);
function load(file, imports, globals) {
  const module = { exports: {} };
  const source = readFileSync(file, 'utf8').replaceAll('import.meta.env.PROD', 'false');
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, {
    module, exports: module.exports, console, setTimeout, clearTimeout, TextEncoder, TextDecoder,
    AbortController: globalThis.AbortController,
    require: (name) => name in imports ? imports[name] : require(name), ...globals,
  }, { filename: file });
  return module.exports;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
function fixture() {
  const hooks = {}; const calls = []; let approve = true; let text = 'alpha'; let newTabs = 0;
  let pendingConfirm = false, confirmationSignal;
  let document;
  class Element {
    inert = false; children = []; listeners = new Map();
    append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((node) => node !== this); }
    setAttribute() {}
    addEventListener(name, fn) { this.listeners.set(name, fn); }
    focus() { document.activeElement = this; }
    scrollIntoView() {}
  }
  const root = new Element(); const body = new Element(); body.append(root);
  document = { body, activeElement: root, createElement: () => new Element(), getElementById: () => root };
  const window = new EventTarget();
  const globals = { document, window, HTMLElement: Element, alert: () => calls.push('alert') };
  const events = load('src/core/events.ts', {}, globals);
  const commands = load('src/core/commands.ts', { './events': events }, globals);
  const settings = { getSetting: (key) => key === 'keybindings' ? {} : [], flushSettings: async () => calls.push('flush') };
  const keys = load('src/core/keybindings.ts', { './commands': commands, './events': events, './settings': settings }, globals);
  const palette = load('src/ui/palette.ts', {
    '../core/commands': commands, '../core/events': events, '../core/keybindings': keys,
    '../core/settings': settings, '../i18n': { t: (key) => key },
  }, globals);
  const ipc = {
    confirm: async (_message, _title, options) => {
      calls.push('confirm');
      confirmationSignal = options?.signal;
      if (pendingConfirm) return new Promise(resolve => confirmationSignal?.addEventListener('abort', () => resolve(false), { once: true }));
      return approve;
    },
    requestQuit: async () => {}, replyQuit: async (id, allow) => calls.push(['reply', id, allow]),
    onQuitRequested: async (fn) => { hooks.quit = fn; },
    onQuitApproved: async (fn) => { hooks.approved = fn; },
    onQuitCancelled: async (fn) => { hooks.cancelled = fn; },
    window: {
      onCloseRequested: async (fn) => { hooks.close = fn; },
      destroy: async () => calls.push('destroy'), close: async () => {},
      minimize: async () => {}, toggleMaximize: async () => {},
    },
  };
  const lifecycle = load('src/ui/window.ts', {
    '../core/commands': commands, '../core/settings': settings, '../core/events': events,
    '../editor/document': { baseName: () => 'draft' },
    '../editor/files': { drainFileOperations: async () => true },
    '../editor/tabs': { listTabs: () => [{ doc: { path: null, dirty: true } }] },
    '../editor/transfer': { cancelOutgoingTransfers: async () => {}, setTransferClosing() {} },
    '../i18n': { t: (key) => key }, '../ipc': { ipc, errorMessage: (error) => error.message },
  }, globals);
  commands.registerCommand({ id: 'editor.replaceNext', title: 'Replace', run: () => { text = 'beta'; } });
  commands.registerCommand({ id: 'file.new', title: 'New', run: () => { newTabs++; } });
  commands.registerCommand({ id: 'palette.open', title: 'Palette', run: palette.openCommandPalette });
  keys.registerKeybinding({ key: 'Ctrl+N', command: 'file.new' });
  keys.registerKeybinding({ key: 'Ctrl+Shift+P', command: 'palette.open' });
  keys.registerKeybinding({ key: 'F1', command: 'palette.open' });
  keys.installKeybindings(window);
  lifecycle.registerWindowCommands();
  function key(name, modifiers = {}) {
    const event = new Event('keydown', { cancelable: true });
    Object.assign(event, { key: name, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...modifiers });
    window.dispatchEvent(event);
    return event;
  }
  return {
    hooks, calls, root, body, commands, palette, lifecycle, key,
    text: () => text, newTabs: () => newTabs, setApprove: (value) => { approve = value; },
    waitForConfirmation: () => { pendingConfirm = true; }, confirmationSignal: () => confirmationSignal,
  };
}

const failures = [];
async function check(name, fn) {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message}`); }
}
async function accepted(f) {
  await f.lifecycle.windowLifecycleReady();
  f.hooks.quit({ requestId: 'q1' });
  await tick();
  assert.ok(f.calls.some((call) => Array.isArray(call) && call[0] === 'reply' && call[2] === true));
}

await check('accepted quit vote disables actual command execution until all votes finish', async () => {
  const f = fixture(); await accepted(f);
  assert.equal(f.commands.isEnabled('editor.replaceNext'), false);
  await f.commands.executeCommand('editor.replaceNext');
  assert.equal(f.text(), 'alpha'); assert.equal(f.calls.includes('destroy'), false);
});
await check('quit freeze closes existing body palette and prevents later picker callbacks', async () => {
  const f = fixture(); let picks = 0;
  f.palette.openPicker([{ label: 'Replace', value: 'replace' }], () => { picks++; });
  const overlay = f.body.children.find((node) => node.className === 'palette-overlay');
  const choose = overlay.children[0].children[1].children[0].listeners.get('mousedown');
  assert.ok(overlay);
  await accepted(f);
  assert.equal(f.body.inert, true);
  assert.equal(f.body.children.some((node) => node.className === 'palette-overlay'), false);
  choose({ preventDefault() {} });
  assert.equal(picks, 0);
  f.palette.openPicker([{ label: 'New', value: 'new' }], () => { picks++; });
  assert.equal(f.body.children.some((node) => node.className === 'palette-overlay'), false);
});
await check('Ctrl+N, Ctrl+Shift+P and F1 are consumed while waiting for another window', async () => {
  const f = fixture(); await accepted(f);
  assert.equal(f.key('n', { ctrlKey: true }).defaultPrevented, true);
  assert.equal(f.key('p', { ctrlKey: true, shiftKey: true }).defaultPrevented, true);
  assert.equal(f.key('F1').defaultPrevented, true);
  await tick();
  assert.equal(f.newTabs(), 0);
  assert.equal(f.body.children.some((node) => node.className === 'palette-overlay'), false);
});
await check('cancelled quit restores commands, hotkeys and body interaction', async () => {
  const f = fixture(); await accepted(f);
  f.hooks.cancelled({ requestId: 'q1' }); await tick();
  assert.equal(f.root.inert, false); assert.equal(f.body.inert, false);
  assert.equal(f.commands.isEnabled('editor.replaceNext'), true);
  await f.commands.executeCommand('editor.replaceNext'); assert.equal(f.text(), 'beta');
  f.key('n', { ctrlKey: true }); await tick(); assert.equal(f.newTabs(), 1);
});
await check('modal confirmation remains callable while commands are frozen', async () => {
  const f = fixture(); await accepted(f);
  assert.equal(f.calls.filter((call) => call === 'confirm').length, 1);
  assert.equal(f.commands.isEnabled('file.new'), false);
});
await check('cancelled native close releases the command gate', async () => {
  const f = fixture(); f.setApprove(false); await f.lifecycle.windowLifecycleReady();
  f.hooks.close({ preventDefault() {} }); await tick();
  assert.equal(f.root.inert, false); assert.equal(f.body.inert, false);
  await f.commands.executeCommand('file.new'); assert.equal(f.newTabs(), 1);
  assert.equal(f.calls.includes('destroy'), false);
});
await check('cancelling a pending installation modal releases the actual body and command gate', async () => {
  const f = fixture(); f.waitForConfirmation(); await f.lifecycle.windowLifecycleReady();
  f.hooks.quit({ requestId: 'pending-install', purpose: 'installUpdate' });
  await tick();
  assert.equal(f.body.inert, true); assert.equal(f.root.inert, true);
  assert.equal(f.commands.isEnabled('editor.replaceNext'), false);
  assert.ok(f.confirmationSignal());
  f.hooks.cancelled({ requestId: 'pending-install' });
  assert.equal(f.confirmationSignal().aborted, true);
  assert.equal(f.body.inert, false); assert.equal(f.root.inert, false);
  await f.commands.executeCommand('editor.replaceNext');
  await tick();
  assert.equal(f.text(), 'beta');
  assert.equal(f.calls.some(call => Array.isArray(call) && call[0] === 'reply'), false);
  assert.equal(f.calls.includes('destroy'), false);
});
if (failures.length) process.exitCode = 1;
