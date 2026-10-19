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
  const tabs = [];
  const openRequests = [];
  let active;
  let tabSequence = 0;
  const makeTab = (path = null, text = '') => {
    const tab = { id: `tab-${++tabSequence}`, doc: { path, dirty: false }, text };
    tabs.push(tab);
    active = tab;
    return tab;
  };
  const pristine = tab => tabs.includes(tab) && tab.doc.path === null && !tab.doc.dirty && tab.text === '';
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
    openRequests.push(args);
    await options.fileTask;
    if (options.failFiles) return;
    if (args.reuseTab && pristine(args.reuseTab)) {
      active = args.reuseTab;
      active.doc.path = args.paths[0];
      active.text = 'disk content';
    } else makeTab(args.paths[0], 'disk content');
  } });
  commands.registerCommand({ id: 'file.save', title: 'Save', when: () => !!active,
    run: () => { calls.push(['save', active]); } });
  let onOpenFiles;
  const ipc = {
    windowReady: async () => {
      options.beforeShow?.(tabs);
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
    './editor/commands': { registerEditorCommands() {} }, './editor/files': {
      setProgressHost() {}, isReusableUntitled: tab => pristine(tab) && !tab.busy,
      newUntitled: () => { calls.push('new-untitled'); return makeTab(); },
    },
    './editor/encodings': { loadAnsi: async () => calls.push('ansi') },
    './editor/tabs': {
      mountEditor: () => calls.push('editor'), listTabs: () => tabs,
      closeTab: id => { const index = tabs.findIndex(tab => tab.id === id); if (index >= 0) tabs.splice(index, 1); },
    },
    './editor/transfer': {
      installIncomingTransferListener: async () => calls.push('transfer-listener'),
      receiveTransferredTab: async () => {
        assert.equal(visible, true); calls.push('transfer'); await options.transferTask;
        return options.failTransfer ? undefined : makeTab(null, 'transferred draft');
      },
    },
    './i18n': i18n,
    './i18n/boot': { initLanguage: async () => { calls.push('language'); await options.language; } },
    './ipc': { ipc }, './markdown/controller': { registerMarkdownCommands() {} },
    './settings/controller': { registerSettingsCommands() {} },
    './ui': { mountUI: () => { calls.push('ui'); return {
      editorHost: {}, previewHost: {}, overlayHost: {}, specialHost: {}, fileDropReady: options.fileDropReady ?? Promise.resolve(),
    }; } },
    './ui/window': { windowLifecycleReady: async () => { calls.push('close-listener'); await options.lifecycle; } },
    './ui/tooltips': { initTooltips() {} },
    './themes': { installThemeWatcher: async () => { calls.push('theme'); await options.theme; } },
    './themes/commands': { registerThemeCommands() {} }, './themes/fonts': { installFontWatcher() {} },
  }, globals);
  return {
    main, startup, globals, commands, calls, marks, frames, document, ipc, tabs, openRequests,
    edit: text => { assert.ok(active, 'typing must have an owned document'); active.text = text; active.doc.dirty = true; },
    beginSave: () => { assert.ok(active); active.busy = true; },
    visible: () => visible, openFiles: (paths) => onOpenFiles(paths),
  };
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

await check('ordinary startup owns a saveable untitled document before the first show', async () => {
  const f = fixture({ beforeShow: tabs => assert.equal(tabs.length, 1, 'show must not expose an orphan placeholder') });
  await f.main.start();
  assert.equal(f.tabs.length, 1);
  assert.equal(f.tabs[0].doc.path, null);
  assert.ok(f.calls.indexOf('new-untitled') < f.calls.indexOf('show-request'));
  f.edit('text typed immediately after startup');
  assert.equal(f.commands.isEnabled('file.save'), true);
  await f.commands.executeCommand('file.save');
  const saved = f.calls.find(call => Array.isArray(call) && call[0] === 'save');
  assert.equal(saved[1], f.tabs[0]);
  assert.equal(saved[1].text, 'text typed immediately after startup');
});

await check('native file-drop subscription is ready before the window is shown', async () => {
  const dropReady = deferred();
  const f = fixture({ fileDropReady: dropReady.promise });
  const started = f.main.start();
  await until(() => f.calls.includes('file-listener'));
  await tick();
  assert.equal(f.frames.length, 0, 'the first paint must wait for the drop listener');
  assert.equal(f.calls.includes('show-request'), false);
  dropReady.resolve();
  await started;
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

await check('startup and second-instance files reuse only the initial pristine document', async () => {
  const f = fixture({ initial: { files: ['one.txt', 'two.txt'] } });
  await f.main.start();
  assert.equal(f.tabs.length, 2, 'startup files must not leave a spare untitled tab');
  assert.deepEqual(f.tabs.map(tab => tab.doc.path), ['one.txt', 'two.txt']);
  assert.equal(f.openRequests[0].reuseTab, f.tabs[0]);
  f.openFiles(['third.txt']);
  await until(() => f.tabs.some(tab => tab.doc.path === 'third.txt'));
  assert.deepEqual(f.tabs.map(tab => tab.doc.path), ['one.txt', 'two.txt', 'third.txt']);
  const second = fixture();
  await second.main.start();
  const initialTab = second.tabs[0];
  second.openFiles(['second-instance.txt']);
  await until(() => second.tabs.some(tab => tab.doc.path === 'second-instance.txt'));
  assert.equal(second.tabs.length, 1);
  assert.equal(second.tabs[0], initialTab);
});

await check('typing during a startup file read keeps the draft beside the loaded file', async () => {
  const file = deferred();
  const f = fixture({ initial: { files: ['slow.txt'] }, fileTask: file.promise });
  const started = f.main.start();
  await until(() => f.openRequests.length === 1);
  f.edit('keep the startup draft');
  file.resolve();
  await started;
  assert.equal(f.tabs.length, 2);
  assert.equal(f.tabs[0].doc.path, null);
  assert.equal(f.tabs[0].text, 'keep the startup draft');
  assert.equal(f.tabs[1].doc.path, 'slow.txt');
});

await check('successful initial transfers remove only the untouched startup blank', async () => {
  const f = fixture({ initial: { files: [], transferToken: 'draft' } });
  await f.main.start();
  assert.equal(f.tabs.length, 1);
  assert.equal(f.tabs[0].text, 'transferred draft');
});

await check('initial transfer and startup files keep their documents without a spare blank', async () => {
  const f = fixture({ initial: { files: ['alongside.txt'], transferToken: 'draft' } });
  await f.main.start();
  assert.equal(f.tabs.length, 2);
  assert.equal(f.tabs[0].text, 'transferred draft');
  assert.equal(f.tabs[1].doc.path, 'alongside.txt');
  assert.equal(f.openRequests[0].here, false, 'transfer windows retain the existing later-file window preference');
});

await check('typing during an initial transfer retains both real documents', async () => {
  const transfer = deferred();
  const f = fixture({ initial: { files: [], transferToken: 'draft' }, transferTask: transfer.promise });
  const started = f.main.start();
  await until(() => f.calls.includes('transfer'));
  f.edit('keep typing during transfer');
  transfer.resolve();
  await started;
  assert.equal(f.tabs.length, 2);
  assert.equal(f.tabs[0].text, 'keep typing during transfer');
  assert.equal(f.tabs[1].text, 'transferred draft');
});

await check('an initial transfer preserves the startup tab with a pending Save As operation', async () => {
  const transfer = deferred();
  const f = fixture({ initial: { files: [], transferToken: 'draft' }, transferTask: transfer.promise });
  const started = f.main.start();
  await until(() => f.calls.includes('transfer'));
  const startupTab = f.tabs[0];
  f.beginSave();
  transfer.resolve();
  await started;
  assert.equal(f.tabs.length, 2);
  assert.equal(f.tabs[0], startupTab);
  assert.equal(f.tabs[1].text, 'transferred draft');
});

await check('failed native drop initialization uses the explicit startup error path', async () => {
  const dropReady = deferred();
  const f = fixture({ fileDropReady: dropReady.promise });
  const started = f.main.start().catch(f.startup.failStartup);
  await until(() => f.calls.includes('file-listener'));
  dropReady.reject(Error('file drop listener failed'));
  await started;
  assert.equal(f.calls.includes('show-request'), false);
  assert.equal(f.calls.includes('failure-visible'), true);
  assert.equal(f.document.documentElement.dataset.startup, 'failed');
});

await check('failed startup file reads and rejected transfers keep a usable untitled document', async () => {
  for (const options of [
    { initial: { files: ['missing.txt'] }, failFiles: true },
    { initial: { files: [], transferToken: 'rejected' }, failTransfer: true },
  ]) {
    const f = fixture(options);
    await f.main.start();
    assert.equal(f.tabs.length, 1);
    assert.equal(f.tabs[0].doc.path, null);
    f.edit('still saveable');
    assert.equal(f.commands.isEnabled('file.save'), true);
  }
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
