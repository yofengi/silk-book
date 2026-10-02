import assert from 'node:assert/strict';
import test from 'node:test';
import console from 'node:console';
import { TextEncoder, TextDecoder } from 'node:util';
import { setImmediate } from 'node:timers';
import { loadModule, fakeTimers } from './test-module.mjs';
import { testDom } from './test-dom.mjs';

async function settingsHarness(patch, initial = {}) {
  let notify;
  const timers = fakeTimers();
  const ipc = {
    bus: { label: 'main' },
    settingsLoad: async () => JSON.stringify(initial),
    settingsPatch: patch,
    onSettingsChanged: async (fn) => { notify = fn; },
  };
  const settings = await loadModule('src/core/settings.ts', { '../ipc': { ipc } }, {
    ...timers, console: { ...console, error() {} },
  });
  await settings.loadSettings();
  await settings.watchSettings();
  return { settings, notify: (snapshot) => notify(snapshot) };
}

test('a failed settings patch remains available for an explicit retry', async () => {
  let attempts = 0;
  let persisted;
  const { settings } = await settingsHarness(async (patch) => {
    if (++attempts === 1) throw new Error('disk temporarily locked');
    persisted = patch.set;
    return { value: persisted, revision: 1 };
  });
  settings.setSetting('editor.lineNumbers', false);
  await assert.rejects(settings.flushSettings(), /temporarily locked/);
  await settings.flushSettings();
  assert.equal(persisted['editor.lineNumbers'], false);
  assert.equal(settings.getSetting('editor.lineNumbers'), false);
});

test('an older settings event cannot undo the latest committed choice', async () => {
  const { settings, notify } = await settingsHarness(async () => { throw new Error('unused'); });
  notify({ value: { 'editor.wordWrap': true }, revision: 2, source: 'win-2' });
  notify({ value: { 'editor.wordWrap': false }, revision: 1, source: 'win-1' });
  assert.equal(settings.getSetting('editor.wordWrap'), true);
});

test('a later remote patch wins when an earlier local response arrives late', async () => {
  let finish;
  const { settings, notify } = await settingsHarness(() => new Promise((resolve) => { finish = resolve; }));
  settings.setSetting('editor.wordWrap', true);
  const saving = settings.flushSettings();
  notify({ value: { 'editor.wordWrap': false, 'editor.lineNumbers': false }, revision: 2, source: 'win-1' });
  finish({ value: { 'editor.wordWrap': true }, revision: 1 });
  await saving;
  assert.equal(settings.getSetting('editor.wordWrap'), false);
  assert.equal(settings.getSetting('editor.lineNumbers'), false);
});

test('concurrent flush requests serialize patches and wait for the newer pending choice', async () => {
  const requests = [];
  const { settings } = await settingsHarness((patch) => new Promise((resolve) => { requests.push({ patch, resolve }); }));
  settings.setSetting('editor.wordWrap', true);
  const first = settings.flushSettings();
  settings.setSetting('editor.wordWrap', false);
  const second = settings.flushSettings();
  assert.equal(requests.length, 1);
  requests[0].resolve({ value: { 'editor.wordWrap': true }, revision: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 2);
  assert.equal(requests[1].patch.set['editor.wordWrap'], false);
  requests[1].resolve({ value: { 'editor.wordWrap': false }, revision: 2 });
  await Promise.all([first, second]);
  assert.equal(settings.getSetting('editor.wordWrap'), false);
});

test('resetting a migrated wrap setting uses the default after reload', async () => {
  let persisted = { 'editor.lineWrap': true };
  let revision = 0;
  const { settings } = await settingsHarness(async ({ set = {}, remove = [] }) => {
    persisted = { ...persisted, ...set };
    for (const key of remove) delete persisted[key];
    return { value: persisted, revision: ++revision };
  }, persisted);
  assert.equal(settings.getSetting('editor.wordWrap'), true);
  settings.resetSetting('editor.wordWrap');
  await settings.flushSettings();
  const reloaded = await settingsHarness(async () => { throw new Error('unused'); }, persisted);
  assert.equal(reloaded.settings.getSetting('editor.wordWrap'), false);
});

test('an invalid stored Tab behavior cannot insert an unsupported number of spaces', async () => {
  const { settings } = await settingsHarness(async () => { throw new Error('unused'); }, { 'editor.tabBehavior': 'spaces9' });
  assert.equal(settings.getSetting('editor.tabBehavior'), 'tab');
});

async function filesHarness({ ipc: overrides = {}, tabs: tabOverrides = {}, doc = {}, text = 'hello' } = {}) {
  const { Text } = await import('@codemirror/state');
  const tab = {
    id: 'tab-1', state: { doc: Text.of(text.split('\n')) },
    doc: { path: 'D:/sample.txt', encoding: 'UTF-8', eol: 'LF', hasBom: false, size: 5, tier: 'Normal', dirty: true, ...doc },
  };
  const marks = [];
  const replacements = [];
  const writes = [];
  const confirmations = [];
  const values = { 'files.readEncoding': 'auto', 'files.recent': [], 'files.recentMax': 20 };
  const ipc = {
    confirm: async (message) => { confirmations.push(message); return true; },
    fileStat: async () => ({ size: 5 }),
    readFile: async (_path, _id, handlers) => {
      handlers.onChunk(new TextEncoder().encode('disk content'));
      return { encoding: 'UTF-8', eol: 'LF', hasBom: false, size: 12 };
    },
    writeFile: async (bytes, opts) => { writes.push({ text: new TextDecoder().decode(bytes), opts }); return { bytesWritten: bytes.length }; },
    saveDialog: async () => 'D:/sample.txt',
    ...overrides,
  };
  const files = await loadModule('src/editor/files.ts', {
    '../core/settings': { getSetting: (key) => values[key], setSetting: (key, value) => { values[key] = value; } },
    '../i18n': { t: (key) => key },
    '../ipc': { ipc, errorMessage: (error) => error.message, isIpcError: (error) => !!error?.kind },
    '../ui/progress': { showProgress: () => { throw new Error('unexpected huge-file UI'); } },
    './document': {
      baseName: (path) => path.split('/').at(-1), sizeTier: () => 'Normal',
      pathKey: (path) => path.replaceAll('/', '\\').toLowerCase(),
    },
    './encodings': { defaultEncoding: () => ({ encoding: 'UTF-8', hasBom: false }), defaultEol: () => 'CRLF', encodingName: (encoding) => encoding },
    './tabs': {
      activateTab() {}, findTabByPath() {}, openTab() {},
      tabText: (t) => t.state.doc.toString(),
      markSaved: (...args) => { marks.push(args); },
      replaceTabContent: (...args) => { replacements.push(args); },
      ...tabOverrides,
    },
  }, { alert: (message) => { throw new Error(message); } });
  return { files, tab, marks, replacements, writes, confirmations, Text };
}

test('saving uses the document and metadata snapshot actually sent to disk', async () => {
  let finish;
  const h = await filesHarness({ ipc: { writeFile: () => new Promise((resolve) => { finish = resolve; }) } });
  const snapshot = h.tab.state.doc;
  const saving = h.files.saveTab(h.tab);
  h.tab.state = { doc: h.Text.of(['hello plus an unsaved edit']) };
  h.tab.doc.eol = 'CR';
  finish({ bytesWritten: 5 });
  assert.equal(await saving, true);
  assert.equal(h.marks[0][2], snapshot);
  assert.equal(h.marks[0][3].eol, 'LF');
});

test('simultaneous Windows path aliases create only one editable document', async () => {
  const opened = [];
  let reads = 0;
  const key = (path) => path.replaceAll('/', '\\').toLowerCase();
  const h = await filesHarness({
    ipc: { readFile: async (_path, _id, handlers) => {
      ++reads;
      await new Promise((resolve) => setImmediate(resolve));
      handlers.onChunk(new TextEncoder().encode('hello'));
      return { encoding: 'UTF-8', eol: 'LF', hasBom: false, size: 5 };
    } },
    tabs: {
      findTabByPath: (path) => opened.find((tab) => key(tab.doc.path) === key(path)),
      openTab: (text, doc) => { const tab = { state: { doc: text }, doc }; opened.push(tab); return tab; },
    },
  });
  const [first, second] = await Promise.all([h.files.openPath('D:/Folder/same.txt'), h.files.openPath('d:\\folder\\SAME.TXT')]);
  assert.equal(opened.length, 1);
  assert.equal(reads, 1);
  assert.equal(first, second);
});

test('malformed input is not overwritten when its data-loss confirmation is declined', async () => {
  let written = false;
  const h = await filesHarness({ doc: { malformed: true }, ipc: {
    confirm: async () => false,
    writeFile: async () => { written = true; return { bytesWritten: 5 }; },
  } });
  assert.equal(await h.files.saveTab(h.tab), false);
  assert.equal(written, false);
  assert.equal(h.marks.length, 0);
});

test('reloading retains edits made while the disk read was pending if discard is declined', async () => {
  let finish;
  const h = await filesHarness({ doc: { dirty: false }, ipc: {
    confirm: async () => false,
    readFile: async (_path, _id, handlers) => {
      handlers.onChunk(new TextEncoder().encode('disk content'));
      return new Promise((resolve) => { finish = resolve; });
    },
  } });
  const reloading = h.files.reloadTab(h.tab);
  await new Promise((resolve) => setImmediate(resolve));
  h.tab.state = { doc: h.Text.of(['new unsaved edit']) };
  h.tab.doc.dirty = true;
  finish({ encoding: 'UTF-8', eol: 'LF', hasBom: false, size: 12 });
  assert.equal(await reloading, false);
  assert.equal(h.replacements.length, 0);
});

test('reload retains the per-document read encoding after the global default changes', async () => {
  let usedEncoding;
  const h = await filesHarness({ doc: { dirty: false, readEncoding: 'utf-8' }, ipc: {
    readFile: async (_path, _id, handlers, encoding) => {
      usedEncoding = encoding;
      handlers.onChunk(new TextEncoder().encode('hello'));
      return { encoding: 'UTF-8', eol: 'LF', hasBom: false, size: 5 };
    },
  } });
  assert.equal(await h.files.reloadTab(h.tab), true);
  assert.equal(usedEncoding, 'utf-8');
});

test('reload follows the newly saved encoding after converting a reopened document', async () => {
  let readEncoding;
  const h = await filesHarness({ doc: { encoding: 'GBK', readEncoding: 'gbk' }, text: '中文',
    tabs: { markSaved: (tab, patch) => { Object.assign(tab.doc, patch, { dirty: false }); } },
    ipc: { readFile: async (_path, _id, handlers, encoding) => {
      readEncoding = encoding;
      handlers.onChunk(new TextEncoder().encode('中文'));
      return { encoding: 'UTF-8', eol: 'LF', hasBom: false, size: 6 };
    } },
  });
  assert.equal(await h.files.saveTab(h.tab, false, { encoding: 'utf-8', hasBom: false }), true);
  assert.equal(await h.files.reloadTab(h.tab), true);
  assert.equal(readEncoding, 'utf-8');
});

test('reload of an empty opened document preserves its encoding and line ending', async () => {
  const h = await filesHarness({ doc: { dirty: false, encoding: 'UTF-16LE', hasBom: true, eol: 'CR' }, text: '', ipc: {
    fileStat: async () => ({ size: 0 }),
    readFile: async () => ({ encoding: 'UTF-8', eol: 'LF', hasBom: false, size: 0 }),
  } });
  assert.equal(await h.files.reloadTab(h.tab), true);
  assert.equal(h.replacements[0][2].encoding, 'UTF-16LE');
  assert.equal(h.replacements[0][2].hasBom, true);
  assert.equal(h.replacements[0][2].eol, 'CR');
});

test('smart copy trims Unicode whitespace only at the selection edges', async () => {
  const { smartTrim } = await loadModule('src/editor/smart-copy.ts');
  assert.equal(smartTrim('\u3000\n  first\n\tsecond  \n\u00a0'), 'first\n\tsecond');
  assert.equal(smartTrim('  \t\n  '), '');
});

async function spellHarness(check) {
  const cmView = await import('@codemirror/view');
  const { EditorState } = await import('@codemirror/state');
  let Plugin;
  await loadModule('src/editor/spellcheck.ts', {
    '@codemirror/view': { ...cmView, ViewPlugin: { fromClass: (implementation) => { Plugin = implementation; return implementation; } } },
    '../ipc': { ipc: { spellCheck: check }, isIpcError: () => false },
  }, { ...fakeTimers(), console: { ...console, warn() {} } });
  return {
    plugin(text) {
      const state = EditorState.create({ doc: text });
      return new Plugin({ state, visibleRanges: [{ from: 0, to: text.length }], dispatch() {} });
    },
  };
}

test('an in-flight spelling result redraws the new tab after the old plugin is destroyed', async () => {
  let complete;
  const h = await spellHarness(() => new Promise((resolve) => { complete = resolve; }));
  const first = h.plugin('mispellt');
  const checking = first.run();
  first.destroy();
  const second = h.plugin('mispellt');
  await second.run();
  assert.equal(second.decorations.size, 0);
  complete(['mispellt']);
  await checking;
  assert.equal(second.decorations.size, 1);
  second.destroy();
});

test('a failed spelling batch releases later words so the next check can retry them', async () => {
  const seen = new Set();
  let calls = 0;
  const words = Array.from({ length: 2101 }, (_v, index) => 'word' + String.fromCharCode(97 + index % 26, 97 + Math.floor(index / 26) % 26, 97 + Math.floor(index / 676)));
  const h = await spellHarness(async (batch) => {
    if (++calls === 1) throw new Error('temporary IPC failure');
    for (const word of batch) seen.add(word);
    return [];
  });
  const plugin = h.plugin(words.join(' '));
  await plugin.run();
  await plugin.run();
  assert.equal(seen.size, words.length);
  plugin.destroy();
});

async function statusHarness() {
  const dom = testDom();
  const timers = fakeTimers();
  const encodingRequests = [];
  const current = { doc: { path: 'D:/sample.txt', encoding: 'UTF-8', hasBom: false, eol: 'LF', tier: 'Normal' }, languageId: 'plaintext' };
  const module = await loadModule('src/ui/statusbar.ts', {
    '../core/commands': { executeCommand() {}, isEnabled: () => true },
    '../core/settings': { getSetting: () => true },
    '../editor/encodings': {
      encodingLabel: () => 'UTF-8', encodingName: (name) => name, sameEncoding: (a, b) => a === b,
      loadEncodings: () => new Promise((resolve) => { encodingRequests.push(resolve); }),
    },
    '../editor/languages': { languageName: () => 'Plain Text' },
    '../editor/tabs': { activeTab: () => current },
    '../i18n': { t: (key) => key },
  }, { ...dom, ...timers });
  const bar = module.mountStatusBar();
  dom.document.body.append(bar);
  await Promise.resolve();
  const menu = () => dom.document.body.children.find((element) => element.getAttribute('role') === 'menu' && !element.className.includes('menu-sub'));
  const submenu = () => dom.document.body.children.find((element) => element.className.includes('menu-sub'));
  return { ...dom, timers, bar, menu, submenu, encodingRequests };
}

test('a late encoding submenu load cannot replace the menu the pointer moved to', async () => {
  const h = await statusHarness();
  h.bar.children.find((element) => element.className.includes('sb-enc')).click();
  const [reopen, save] = h.menu().children;
  reopen.dispatchEvent({ type: 'pointerenter' });
  save.dispatchEvent({ type: 'pointerenter' });
  h.encodingRequests[2]([{ id: 'utf-8', label: 'UTF-8', group: 'Unicode', bom: false }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.submenu().getAttribute('aria-label'), 'statusbar.saveWithEncoding');
  h.encodingRequests[1]([{ id: 'utf-8', label: 'UTF-8', group: 'Unicode', bom: false }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.submenu().getAttribute('aria-label'), 'statusbar.saveWithEncoding');
});

test('a hover-opened menu stays open once the user starts keyboard navigation', async () => {
  const h = await statusHarness();
  const owner = h.bar.children.find((element) => element.className.includes('sb-eol'));
  owner.dispatchEvent({ type: 'pointerenter' });
  await h.timers.run();
  const menu = h.menu();
  menu.children[0].focus();
  menu.dispatchEvent({ type: 'keydown', key: 'ArrowDown', preventDefault() {}, stopPropagation() {} });
  menu.dispatchEvent({ type: 'pointerleave' });
  await h.timers.run();
  assert.equal(h.menu(), menu);
});

async function windowHarness({ cancelTransfers = async () => {}, drainFiles = async () => true, confirm = async () => true } = {}) {
  const hooks = {};
  const calls = [];
  const root = { inert: false };
  const tabs = [];
  let commandBlocked = false;
  const module = await loadModule('src/ui/window.ts', {
    '../core/commands': {
      registerCommand() {},
      isCommandExecutionBlocked: () => commandBlocked,
      setCommandExecutionBlocked: (value) => { commandBlocked = value; },
    },
    '../core/settings': { flushSettings: async () => { calls.push('flush'); } },
    '../editor/document': { baseName: () => 'draft' },
    '../editor/files': { drainFileOperations: drainFiles },
    '../editor/tabs': { listTabs: () => tabs },
    '../editor/transfer': {
      cancelOutgoingTransfers: () => cancelTransfers(tabs),
      setTransferClosing: (value) => { calls.push(['transferGate', value]); },
    },
    '../i18n': { t: (key) => key },
    '../ipc': { errorMessage: (error) => error.message, ipc: {
      confirm: (...args) => { calls.push('confirm'); return confirm(...args); },
      requestQuit() {},
      replyQuit: async (id, allow) => { calls.push(['vote', id, allow]); },
      onQuitRequested: async (fn) => { hooks.quit = fn; },
      onQuitApproved: async (fn) => { hooks.approved = fn; },
      onQuitCancelled: async (fn) => { hooks.cancelled = fn; },
      window: {
        onCloseRequested: async (fn) => { hooks.close = fn; },
        destroy: async () => { calls.push('destroy'); },
      },
    } },
  }, { AbortController: globalThis.AbortController, document: { getElementById: () => root }, alert: (message) => { calls.push(['alert', message]); } });
  module.registerWindowCommands();
  await module.windowLifecycleReady();
  return { hooks, calls, tabs, root };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('native close waits for incoming draft hydration before asking to discard it', async () => {
  let finishIncoming;
  const h = await windowHarness({
    cancelTransfers: async (tabs) => { await new Promise((resolve) => { finishIncoming = resolve; }); tabs.push({ doc: { path: null, dirty: true } }); },
    confirm: async () => false,
  });
  let prevented = false;
  h.hooks.close({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(h.root.inert, true);
  await settle();
  assert.equal(h.calls.includes('confirm'), false);
  finishIncoming();
  await settle();
  assert.equal(h.calls.includes('confirm'), true);
  assert.equal(h.calls.includes('destroy'), false);
  assert.equal(h.root.inert, false);
});

test('quit-approved only closes a matching session after this window voted yes', async () => {
  let complete;
  const h = await windowHarness({ cancelTransfers: () => new Promise((resolve) => { complete = resolve; }) });
  h.hooks.quit({ requestId: 'q1' });
  h.hooks.approved({ requestId: 'q1' });
  await settle();
  assert.equal(h.calls.includes('destroy'), false);
  complete();
  await settle();
  assert.ok(h.calls.some((call) => Array.isArray(call) && call[0] === 'vote' && call[1] === 'q1' && call[2] === true));
  h.hooks.approved({ requestId: 'stale-id' });
  await settle();
  assert.equal(h.calls.includes('destroy'), false);
  h.hooks.approved({ requestId: 'q1' });
  await settle();
  assert.equal(h.calls.filter((call) => call === 'destroy').length, 1);
});

test('a cancelled quit ignores a dirty confirmation that resolves afterwards', async () => {
  let answer;
  const h = await windowHarness({ confirm: () => new Promise((resolve) => { answer = resolve; }) });
  h.tabs.push({ doc: { path: null, dirty: true } });
  h.hooks.quit({ requestId: 'q1' });
  await settle();
  h.hooks.cancelled({ requestId: 'q1' });
  assert.equal(h.root.inert, false);
  answer(true);
  await settle();
  assert.equal(h.calls.includes('destroy'), false);
  assert.equal(h.calls.some((call) => Array.isArray(call) && call[0] === 'vote'), false);
});

test('a local close racing an app quit shares one confirmation and waits for all votes', async () => {
  let answer;
  const h = await windowHarness({ confirm: () => new Promise((resolve) => { answer = resolve; }) });
  h.tabs.push({ doc: { path: null, dirty: true } });
  h.hooks.close({ preventDefault() {} });
  await settle();
  h.hooks.quit({ requestId: 'q1' });
  answer(true);
  await settle();
  assert.equal(h.calls.filter((call) => call === 'confirm').length, 1);
  assert.equal(h.calls.includes('destroy'), false);
  h.hooks.approved({ requestId: 'q1' });
  await settle();
  assert.equal(h.calls.filter((call) => call === 'destroy').length, 1);
});

test('a cancelled installation immediately aborts its pending confirmation and later retries use a fresh signal', async () => {
  const pending = [];
  const h = await windowHarness({ confirm: (_message, _title, options) => new Promise((resolve) => {
    const signal = options?.signal;
    pending.push({ signal, resolve });
    signal?.addEventListener('abort', () => resolve(false), { once: true });
  }) });
  h.tabs.push({ doc: { path: null, dirty: true } });
  h.hooks.quit({ requestId: 'install-old', purpose: 'installUpdate' });
  await settle();
  assert.ok(pending[0]?.signal, 'the lifecycle must provide an abortable confirmation');
  h.hooks.cancelled({ requestId: 'install-old' });
  assert.equal(pending[0].signal.aborted, true, 'another window cancellation closes the dialog immediately');
  assert.equal(h.root.inert, false);
  await settle();
  assert.equal(h.calls.some(call => Array.isArray(call) && (call[0] === 'vote' || call[0] === 'alert')), false);
  h.hooks.quit({ requestId: 'install-new', purpose: 'installUpdate' });
  await settle();
  assert.equal(pending.length, 2, 'retry must not wait for an answer to the stale dialog');
  assert.equal(pending[1].signal.aborted, false);
  assert.notEqual(pending[0].signal, pending[1].signal);
  pending[0].resolve(true);
  pending[1].resolve(false);
  await settle();
  const votes = h.calls.filter(call => Array.isArray(call) && call[0] === 'vote');
  assert.equal(votes.length, 1);
  assert.equal(votes[0][1], 'install-new');
  assert.equal(votes[0][2], false);
  assert.equal(h.root.inert, false);
});

test('cancelling app quit preserves the still-pending confirmation shared with a local close', async () => {
  let answer, signal;
  const h = await windowHarness({ confirm: (_message, _title, options) => {
    signal = options?.signal;
    return new Promise(resolve => { answer = resolve; });
  } });
  h.tabs.push({ doc: { path: null, dirty: true } });
  h.hooks.close({ preventDefault() {} });
  await settle();
  h.hooks.quit({ requestId: 'shared-quit' });
  h.hooks.cancelled({ requestId: 'shared-quit' });
  assert.ok(signal, 'the original local confirmation must be abortable');
  assert.equal(signal.aborted, false, 'an independent local close still owns this confirmation');
  assert.equal(h.root.inert, true);
  answer(false);
  await settle();
  assert.equal(h.calls.filter(call => call === 'confirm').length, 1);
  assert.equal(h.calls.some(call => Array.isArray(call) && call[0] === 'vote'), false);
  assert.equal(h.calls.includes('destroy'), false);
  assert.equal(h.root.inert, false);
});

test('cancelled quit retries queued behind a slow file drain never reopen an orphan confirmation', async () => {
  let finishDrain;
  const h = await windowHarness({ drainFiles: () => new Promise(resolve => { finishDrain = resolve; }) });
  h.tabs.push({ doc: { path: null, dirty: true } });
  h.hooks.quit({ requestId: 'draining-old' });
  await settle();
  h.hooks.cancelled({ requestId: 'draining-old' });
  h.hooks.quit({ requestId: 'queued-new', purpose: 'installUpdate' });
  h.hooks.cancelled({ requestId: 'queued-new' });
  assert.equal(h.root.inert, false);
  finishDrain(true);
  await settle();
  assert.equal(h.calls.includes('confirm'), false);
  assert.equal(h.root.inert, false, 'old work completing must not freeze a cancelled session again');
  assert.equal(h.calls.some(call => Array.isArray(call) && call[0] === 'vote'), false);
});
