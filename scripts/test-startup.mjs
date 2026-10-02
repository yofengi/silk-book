// Actual TS startup/command code with controlled IPC, hidden RAF and failed initialization.
/* global console, setTimeout, clearTimeout, process */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function load(file, imports, globals = {}) {
  const module = { exports: {} };
  const code = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, {
    module, exports: module.exports, console: { warn() {}, error() {} }, setTimeout, clearTimeout,
    require: (name) => {
      if (name.endsWith('.css')) return {};
      if (name in imports) return imports[name];
      throw Error(`Unexpected import: ${name}`);
    },
    ...globals,
  }, { filename: file });
  return module.exports;
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function until(predicate) {
  for (let i = 0; i < 1000 && !predicate(); i++) await tick();
  assert.ok(predicate(), 'expected startup stage was not reached');
}

class Element {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.dataset = {};
    this.textContent = '';
    this.style = { setProperty() {} };
    this.handlers = {};
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  addEventListener(event, fn) { this.handlers[event] = fn; }
  getBoundingClientRect() { return { width: 1000, height: 700 }; }
}

function fixture(options = {}) {
  const calls = [], marks = [], frames = [];
  let visible = false;
  const root = new Element('app');
  const document = {
    documentElement: new Element('html'), body: new Element('body'),
    getElementById: () => root, createElement: (tag) => new Element(tag),
  };
  const globals = {
    document, performance: { mark: (name) => marks.push(name) },
    requestAnimationFrame: (fn) => { frames.push(fn); return frames.length; },
    cancelAnimationFrame() {},
  };
  const { events } = load('src/core/events.ts', {});
  const commands = load('src/core/commands.ts', { './events': { events } });
  commands.registerCommand({ id: 'file.open', title: 'Open', run: async (_ctx, args) => {
    assert.equal(visible, true, 'file reads/dialogs must start after native show succeeds');
    calls.push(['open', args.paths]);
    return options.fileTask;
  } });
  let onOpenFiles;
  const ipc = {
    windowReady: async () => {
      calls.push('show-request');
      await options.ready;
      visible = true;
      calls.push('visible');
    },
    windowStartupFailed: async () => { visible = true; calls.push('failure-visible'); },
    window: { setTitle: async () => {}, close: async () => calls.push('close') },
    onOpenFiles: async (fn) => { onOpenFiles = fn; calls.push('file-listener'); },
    windowInit: async () => {
      assert.equal(visible, true);
      calls.push('init');
      if (options.quitBeforeInit) commands.setCommandExecutionBlocked(true);
      return options.initial ?? { files: [] };
    },
  };
  const i18n = { productName: () => 'silk book', t: (key) => key };
  const startup = load('src/core/startup.ts', {
    '../ipc': { ipc, errorMessage: (error) => error.message }, '../i18n': i18n,
  }, globals);
  const main = load('src/main.ts', {
    './core/commands': commands, './core/events': { events },
    './core/keybindings': { installKeybindings() {} },
    './core/settings': {
      loadSettings: async () => { calls.push('settings'); await options.settings; },
      watchSettings: async () => { calls.push('settings-listener'); },
    },
    './core/updates': { startUpdateService() {} }, './core/startup': startup,
    './editor/commands': { registerEditorCommands() {} }, './editor/files': { setProgressHost() {} },
    './editor/encodings': { loadAnsi: async () => calls.push('ansi') },
    './editor/tabs': { mountEditor: () => calls.push('editor') },
    './editor/transfer': {
      installIncomingTransferListener: async () => calls.push('transfer-listener'),
      receiveTransferredTab: async () => { assert.equal(visible, true); calls.push('transfer'); },
    },
    './i18n': i18n,
    './i18n/boot': { initLanguage: async () => { calls.push('language'); await options.language; } },
    './ipc': { ipc }, './markdown/controller': { registerMarkdownCommands() {} },
    './settings/controller': { registerSettingsCommands() {} },
    './ui': { mountUI: () => { calls.push('ui'); return { editorHost: {}, previewHost: {}, overlayHost: {}, specialHost: {} }; } },
    './ui/window': { windowLifecycleReady: async () => { calls.push('close-listener'); await options.lifecycle; } },
    './themes': { installThemeWatcher: async () => { calls.push('theme'); await options.theme; } },
    './themes/commands': { registerThemeCommands() {} }, './themes/fonts': { installFontWatcher() {} },
  }, globals);
  return { main, startup, globals, commands, calls, marks, frames, document, ipc, visible: () => visible, openFiles: (paths) => onOpenFiles(paths) };
}

const failures = [];
async function check(name, fn) {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.stack}`); }
}

await check('native show waits for theme, mounted editor and all lifecycle subscriptions', async () => {
  const theme = deferred(), lifecycle = deferred();
  const f = fixture({ theme: theme.promise, lifecycle: lifecycle.promise });
  const started = f.main.start();
  await until(() => f.calls.includes('theme'));
  assert.equal(f.calls.includes('ui'), false);
  assert.equal(f.calls.includes('show-request'), false);
  theme.resolve();
  await until(() => f.calls.includes('close-listener'));
  assert.equal(f.calls.includes('show-request'), false);
  lifecycle.resolve();
  await started;
  for (const step of ['theme', 'ui', 'editor', 'close-listener', 'transfer-listener', 'file-listener']) {
    assert.ok(f.calls.indexOf(step) < f.calls.indexOf('show-request'), step);
  }
  assert.deepEqual(f.marks, ['startup:ui-ready', 'startup:window-shown']);
});

await check('hidden WebViews without RAF still reach show through the bounded fallback', async () => {
  const f = fixture();
  await f.main.start();
  assert.equal(f.frames.length, 1);
  assert.equal(f.visible(), true);
});

await check('two available animation frames can complete without waiting for the fallback', async () => {
  const f = fixture();
  const paint = f.startup.paintOpportunity();
  f.frames[0]();
  assert.equal(f.frames.length, 2);
  f.frames[1]();
  await paint;
});

await check('initial large-file work starts after visible first screen', async () => {
  const file = deferred();
  const f = fixture({ initial: { files: ['large.txt'] }, fileTask: file.promise });
  let complete = false;
  const started = f.main.start().then(() => { complete = true; });
  await until(() => f.calls.some((call) => Array.isArray(call) && call[0] === 'open'));
  assert.equal(f.visible(), true);
  assert.equal(complete, false);
  assert.ok(f.marks.includes('startup:window-shown'));
  file.resolve();
  await started;
});

await check('second-instance files and initial transferred drafts cannot run while show is pending', async () => {
  const ready = deferred();
  const f = fixture({ ready: ready.promise, initial: { files: [], transferToken: 'draft' } });
  const started = f.main.start();
  await until(() => f.calls.includes('show-request'));
  f.openFiles(['second-instance.txt']);
  await tick();
  assert.equal(f.calls.includes('init'), false);
  assert.equal(f.calls.includes('transfer'), false);
  assert.equal(f.calls.some((call) => Array.isArray(call)), false);
  ready.resolve();
  await started;
  await until(() => f.calls.some((call) => Array.isArray(call)));
  assert.equal(f.calls.includes('transfer'), true);
});

await check('cancelled early Quit retains startup files until commands become available again', async () => {
  const f = fixture({ quitBeforeInit: true, initial: { files: ['one.txt', 'two.txt'] } });
  const started = f.main.start();
  await until(() => f.calls.includes('init'));
  await tick();
  assert.equal(f.calls.some((call) => Array.isArray(call)), false);
  f.openFiles(['second.txt']);
  await tick();
  assert.equal(f.calls.some((call) => Array.isArray(call)), false);
  f.commands.setCommandExecutionBlocked(false);
  await started;
  await until(() => f.calls.filter(Array.isArray).length === 3);
  assert.deepEqual(f.calls.filter(Array.isArray).map((call) => call[1][0]).sort(), ['one.txt', 'second.txt', 'two.txt']);
});

await check('failed initialization renders an explicit error and invokes the failed-window display path', async () => {
  const f = fixture({ language: Promise.reject(Error('language could not load')) });
  await f.main.start().catch(f.startup.failStartup);
  assert.equal(f.document.documentElement.dataset.startup, 'failed');
  assert.equal(f.calls.includes('show-request'), false);
  assert.equal(f.calls.includes('failure-visible'), true);
  const panel = f.document.body.children[0];
  assert.equal(panel.children[1].textContent, 'language could not load');
  panel.children.at(-1).handlers.click();
  await tick();
  assert.ok(f.calls.includes('close'));
});

await check('bootstrap catches a failed main module import instead of leaving the window hidden', async () => {
  let failure;
  load('src/bootstrap.ts', {
    './core/startup': { failStartup: (error) => { failure = error; } },
    get './main'() { throw Error('main module missing'); },
  });
  await until(() => failure !== undefined);
  assert.equal(failure.message, 'main module missing');
});

await check('the Tauri ready adapter sends no caller-selected window label', async () => {
  const invocations = [];
  const { tauriIpc } = load('src/ipc/tauri.ts', {
    '@tauri-apps/api/core': { invoke: async (...args) => invocations.push(args) },
    '@tauri-apps/api/window': {}, '@tauri-apps/api/webviewWindow': {},
    '@tauri-apps/api/event': {}, '@tauri-apps/plugin-opener': {}, '@tauri-apps/plugin-dialog': {},
    '../i18n': {}, './types': {},
  });
  await tauriIpc.windowReady();
  assert.deepEqual(invocations[0], ['window_frontend_ready']);
});

if (failures.length) process.exitCode = 1;
