// Real file/save, tab snapshot, command gate, and lifecycle integration.
/* global console, setTimeout, clearTimeout, TextEncoder, TextDecoder */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const { EditorState } = require('@codemirror/state');
function load(file, imports, globals = {}) {
  const module = { exports: {} };
  const code = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, {
    module, exports: module.exports, console, setTimeout, clearTimeout, TextEncoder, TextDecoder,
    require: name => name in imports ? imports[name] : require(name), ...globals,
  }, { filename: file });
  return module.exports;
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function eventually(predicate, message, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
async function fixture(t, { failWrite = false, readDelayMs = 0 } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'boshu-window-drain-'));
  assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep), 'Fixture cleanup must stay inside the temporary directory');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'draft.txt');
  await writeFile(file, 'old disk text');
  const calls = [], hooks = {}, writeGates = [], readGates = [], dialogGates = [];
  const root = { inert: false }, body = { inert: false };
  let confirms = true;
  const globals = { document: { body, getElementById: () => root }, alert: message => calls.push(['alert', message]) };
  const events = load('src/core/events.ts', {}, globals);
  const commands = load('src/core/commands.ts', { './events': events }, globals);
  const values = { 'files.recent': [], 'files.recentMax': 20, 'files.readEncoding': 'auto', 'editor.tabSize': 4 };
  const settings = {
    getSetting: key => values[key], setSetting: (key, value) => { values[key] = value; },
    flushSettings: async () => calls.push('flush'),
  };
  const i18n = { t: key => key };
  const documentModel = load('src/editor/document.ts', { '../core/settings': settings, '../i18n': i18n }, globals);
  const large = load('src/editor/large-file.ts', { '../core/settings': settings, './document': documentModel }, globals);
  const tabs = load('src/editor/tabs.ts', {
    '../core/events': events, '../core/settings': settings, './document': documentModel,
    '../i18n': i18n, './large-file': large,
    './languages': { languageForPath: () => undefined, PLAIN_TEXT: { id: 'plaintext' } },
    '../themes': {}, './view': { createState: text => EditorState.create({ doc: text }) },
    './smart-copy': {}, './spellcheck': {},
  }, globals);
  const ipc = {
    confirm: async message => { calls.push(['confirm', message]); return confirms; },
    saveDialog: async () => {
      const gate = deferred(); dialogGates.push(gate);
      await gate.promise;
      return file;
    },
    fileStat: async () => ({ size: 13 }),
    readFile: async (_file, _id, handlers) => {
      const gate = deferred(); readGates.push(gate);
      await gate.promise;
      if (readDelayMs) await new Promise(resolve => setTimeout(resolve, readDelayMs));
      const bytes = await readFile(_file);
      handlers.onChunk(bytes);
      return { encoding: 'UTF-8', hasBom: false, eol: 'LF', size: bytes.length };
    },
    writeFile: async (bytes, opts) => {
      const gate = deferred(); writeGates.push(gate);
      await gate.promise;
      if (failWrite) throw new Error('disk unavailable');
      await writeFile(opts.path, bytes);
      calls.push('disk-written');
      return { bytesWritten: bytes.length };
    },
    replyQuit: async (requestId, allow) => calls.push(['reply', requestId, allow]),
    onQuitRequested: async fn => { hooks.quit = fn; },
    onQuitApproved: async fn => { hooks.approved = fn; },
    onQuitCancelled: async fn => { hooks.cancelled = fn; },
    window: {
      onCloseRequested: async fn => { hooks.close = fn; },
      destroy: async () => calls.push('destroy'),
    },
  };
  const files = load('src/editor/files.ts', {
    '../core/commands': commands, '../core/events': events, '../core/settings': settings,
    '../i18n': i18n, '../ipc': { ipc, errorMessage: error => error.message, isIpcError: () => false },
    '../ui/progress': {}, './document': documentModel, './large-file': large, './tabs': tabs,
    './encodings': { defaultEncoding: () => ({ encoding: 'UTF-8', hasBom: false }), defaultEol: () => 'LF' },
  }, globals);
  const lifecycle = load('src/ui/window.ts', {
    '../core/commands': commands, '../core/settings': settings, '../editor/document': documentModel,
    '../editor/files': files, '../editor/tabs': tabs,
    '../editor/transfer': { setTransferClosing() {}, cancelOutgoingTransfers: async () => {} },
    '../i18n': i18n, '../ipc': { ipc, errorMessage: error => error.message },
  }, globals);
  await lifecycle.windowLifecycleReady();
  const tab = tabs.openTab('saving text', { path: file, dirty: true });
  const votes = () => calls.filter(call => Array.isArray(call) && call[0] === 'reply');
  return { file, files, tab, tabs, hooks, calls, writeGates, readGates, dialogGates, root, body, commands, votes,
    decline: () => { confirms = false; } };
}

test('installation waits for a real delayed save before voting and uses the committed snapshot', async t => {
  const f = await fixture(t);
  const saving = f.files.saveTab(f.tab);
  f.hooks.quit({ requestId: 'install-save', purpose: 'installUpdate' });
  await tick();
  assert.equal(f.body.inert, true);
  assert.equal(f.votes().length, 0, 'no approved vote may precede disk completion');
  assert.equal(await f.files.saveTab(f.tab), false, 'freeze rejects a new save without blocking the existing one');
  assert.equal(f.writeGates.length, 1);
  assert.equal(await readFile(f.file, 'utf8'), 'old disk text');
  f.writeGates[0].resolve();
  assert.equal(await saving, true);
  await eventually(() => f.votes().length === 1, 'installation vote must follow the committed save');
  assert.equal(await readFile(f.file, 'utf8'), 'saving text');
  assert.equal(f.tab.doc.dirty, false, 'real markSaved uses the written snapshot');
  assert.equal(f.votes()[0]?.[2], true);
  assert.equal(f.calls.some(call => Array.isArray(call) && call[0] === 'confirm'), false);
  assert.equal(f.calls.includes('destroy'), false);
});

test('queued saves behind a pending reload all finish before ordinary quit approval', async t => {
  const f = await fixture(t);
  f.tab.doc.dirty = false;
  const reloading = f.files.reloadTab(f.tab);
  await eventually(() => f.readGates.length === 1, 'reload must reach its pending disk read');
  const first = f.files.saveTab(f.tab);
  const second = f.files.saveTab(f.tab);
  f.hooks.quit({ requestId: 'queued-saves' });
  await tick();
  assert.equal(f.votes().length, 0);
  assert.equal(f.writeGates.length, 0);
  f.readGates[0].resolve();
  assert.equal(await reloading, true);
  await eventually(() => f.writeGates.length === 1, 'the first queued save must start after reload');
  assert.equal(f.writeGates.length, 1);
  f.writeGates[0].resolve();
  await first;
  await eventually(() => f.writeGates.length === 2, 'the second queued save must start after the first');
  assert.equal(f.writeGates.length, 2);
  assert.equal(f.votes().length, 0);
  f.writeGates[1].resolve();
  await second;
  await eventually(() => f.votes().length === 1, 'ordinary quit must vote after both saves complete');
  assert.equal(f.votes()[0]?.[2], true);
  assert.equal(f.calls.filter(call => call === 'disk-written').length, 2);
});

test('an existing Save As dialog can finish after freeze and its write must finish before approval', async t => {
  const f = await fixture(t);
  const saving = f.files.saveTab(f.tab, true);
  f.hooks.quit({ requestId: 'save-as', purpose: 'installUpdate' });
  await tick();
  assert.equal(f.votes().length, 0);
  assert.equal(f.writeGates.length, 0);
  f.dialogGates[0].resolve();
  await eventually(() => f.writeGates.length === 1, 'the accepted Save As path must start its write');
  assert.equal(f.writeGates.length, 1, 'the already registered save may proceed through the closed command gate');
  assert.equal(f.votes().length, 0);
  f.writeGates[0].resolve();
  await saving;
  await eventually(() => f.votes().length === 1, 'Save As must finish before installation approval');
  assert.equal(await readFile(f.file, 'utf8'), 'saving text');
  assert.equal(f.votes()[0]?.[2], true);
});

test('an already started batch open finishes its remaining reads before the dirty snapshot', async t => {
  // Explicit latency reproduces slow real filesystem completion under build load.
  const f = await fixture(t, { readDelayMs: 20 });
  f.tab.doc.dirty = false;
  const paths = [f.file + '.one', f.file + '.two'];
  for (const file of paths) await writeFile(file, 'read me');
  const batch = (async () => { for (const file of paths) await f.files.openPath(file); })();
  await eventually(() => f.readGates.length === 1, 'the first selected file must reach its disk read');
  f.hooks.quit({ requestId: 'pending-read', purpose: 'installUpdate' });
  await tick();
  assert.equal(f.votes().length, 0);
  f.readGates[0].resolve();
  await eventually(() => f.readGates.length === 2, 'the second selected file must reach its disk read after the first completes');
  assert.equal(f.readGates.length, 2, 'freeze must not silently skip the rest of a selected batch');
  assert.equal(f.votes().length, 0);
  f.readGates[1].resolve();
  await batch;
  await eventually(() => f.votes().length === 1, 'the dirty snapshot must follow completion of the entire read batch');
  assert.equal(f.tabs.listTabs().length, 3);
  assert.equal(f.votes()[0]?.[2], true);
});

test('edits made during an earlier save remain dirty and are confirmed after the disk write', async t => {
  const f = await fixture(t);
  const saving = f.files.saveTab(f.tab);
  f.tab.state = f.tab.state.update({ changes: { from: f.tab.state.doc.length, insert: ' plus new edit' } }).state;
  f.decline();
  f.hooks.quit({ requestId: 'new-edit', purpose: 'installUpdate' });
  await tick();
  assert.equal(f.calls.some(call => Array.isArray(call) && call[0] === 'confirm'), false);
  f.writeGates[0].resolve();
  await saving;
  await eventually(() => f.votes().length === 1, 'new edits must be confirmed before installation voting');
  assert.equal(await readFile(f.file, 'utf8'), 'saving text');
  assert.equal(f.tab.doc.dirty, true);
  assert.equal(f.tab.state.doc.toString(), 'saving text plus new edit');
  assert.equal(f.votes()[0]?.[2], false);
  assert.equal(f.body.inert, false);
  assert.ok(f.calls.some(call => Array.isArray(call) && call[0] === 'confirm' && call[1] === 'window.installDirtyConfirm'));
});

test('a failed in-flight write vetoes this installation and keeps the editor usable', async t => {
  const f = await fixture(t, { failWrite: true });
  const saving = f.files.saveTab(f.tab);
  f.hooks.quit({ requestId: 'failed-write', purpose: 'installUpdate' });
  await tick();
  assert.equal(f.votes().length, 0);
  f.writeGates[0].resolve();
  assert.equal(await saving, false);
  await eventually(() => f.votes().length === 1, 'the failed write must veto this installation');
  assert.equal(f.votes()[0]?.[2], false);
  assert.equal(f.tab.doc.dirty, true);
  assert.equal(f.body.inert, false);
  assert.equal(f.commands.isCommandExecutionBlocked(), false);
  assert.equal(await readFile(f.file, 'utf8'), 'old disk text');
  // A prior failed operation must not permanently poison subsequent attempts.
  f.decline();
  f.hooks.quit({ requestId: 'retry-dirty', purpose: 'installUpdate' });
  await eventually(() => f.votes().length === 2, 'a later attempt must re-evaluate dirty state');
  assert.ok(f.calls.some(call => Array.isArray(call) && call[0] === 'confirm'));
  assert.equal(f.votes().length, 2);
  assert.equal(f.calls.includes('destroy'), false);
});

test('cancelled installation never sends a stale vote when an existing save finishes later', async t => {
  const f = await fixture(t);
  const saving = f.files.saveTab(f.tab);
  f.hooks.quit({ requestId: 'cancel-during-save', purpose: 'installUpdate' });
  await tick();
  f.hooks.cancelled({ requestId: 'cancel-during-save' });
  assert.equal(f.body.inert, false);
  f.writeGates[0].resolve();
  await saving;
  await tick();
  assert.equal(f.votes().length, 0);
  assert.equal(f.calls.includes('destroy'), false);
  assert.equal(await readFile(f.file, 'utf8'), 'saving text');
});
