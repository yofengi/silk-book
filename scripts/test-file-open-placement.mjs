/* global console, setTimeout, TextEncoder, TextDecoder */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const { Compartment, EditorState } = require('@codemirror/state');
const { EditorView } = require('@codemirror/view');
function load(file, imports, globals = {}) {
  const module = { exports: {} };
  const code = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, {
    module, exports: module.exports, console, setTimeout, TextEncoder, TextDecoder,
    require: name => name in imports ? imports[name] : require(name), ...globals,
  }, { filename: file });
  return module.exports;
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function until(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await tick();
  }
  assert.fail('Expected pending file operation');
}
function fixture() {
  const reads = [], alerts = [], saves = [], windows = [];
  const globals = { document: { activeElement: null }, alert: message => alerts.push(message) };
  const eventModule = load('src/core/events.ts', {}, globals);
  const commands = load('src/core/commands.ts', { './events': eventModule }, globals);
  const values = {
    'files.recent': [], 'files.recentMax': 20, 'files.readEncoding': 'auto',
    'editor.tabSize': 4, 'window.openFilesInNewWindow': true,
  };
  const settings = { getSetting: key => values[key], setSetting: (key, value) => { values[key] = value; } };
  const i18n = { t: key => key };
  const documentModel = load('src/editor/document.ts', { '../core/settings': settings, '../i18n': i18n }, globals);
  const large = load('src/editor/large-file.ts', { '../core/settings': settings, './document': documentModel }, globals);
  const tabs = load('src/editor/tabs.ts', {
    '../core/events': eventModule, '../core/settings': settings, './document': documentModel,
    '../i18n': i18n, './large-file': large,
    './languages': { languageForPath: () => undefined, languageById: () => undefined, PLAIN_TEXT: { id: 'plaintext' } },
    '../themes': {}, './smart-copy': {}, './spellcheck': {},
    './view': {
      compartments: { language: new Compartment(), completion: new Compartment() }, completionExt: () => [],
      createState: (text, _flags, _size, extensions) => EditorState.create({ doc: text, extensions: extensions ?? [] }),
      createView: (_parent, state) => ({
        state, focus() {}, setState(next) { this.state = next; },
        dispatch(transaction) {
          const previous = this.state;
          this.state = this.state.update(transaction).state;
          const update = { docChanged: !previous.doc.eq(this.state.doc), state: this.state };
          for (const listener of this.state.facet(EditorView.updateListener)) listener(update);
        },
      }),
    },
  }, globals);
  tabs.mountEditor({});
  const ipc = {
    fileStat: async () => ({ size: 8 }),
    readFile: (path, _id, handlers) => new Promise((resolve, reject) => {
      reads.push({ path, reject, finish: (text = path) => {
        const bytes = new TextEncoder().encode(text);
        handlers.onChunk(bytes);
        resolve({ encoding: 'UTF-8', hasBom: false, eol: 'LF', size: bytes.length });
      } });
    }),
    saveDialog: () => new Promise(resolve => saves.push(resolve)),
    writeFile: async bytes => ({ bytesWritten: bytes.length }),
    windowOpen: async options => { windows.push(options); },
    confirm: async () => true,
  };
  const ipcModule = { ipc, errorMessage: error => error.message, isIpcError: error => !!error.kind };
  const encodings = { defaultEncoding: () => ({ encoding: 'UTF-8', hasBom: false }), defaultEol: () => 'LF' };
  const files = load('src/editor/files.ts', {
    '../core/events': eventModule, '../core/commands': commands, '../core/settings': settings,
    '../i18n': i18n, '../ipc': ipcModule, '../ui/progress': {},
    './document': documentModel, './large-file': large, './tabs': tabs, './encodings': encodings,
  }, globals);
  const editorCommands = load('src/editor/commands.ts', {
    '../core/commands': commands, '../core/keybindings': { registerKeybinding() {} }, '../core/settings': settings,
    '../i18n': i18n, '../ipc': ipcModule, './document': documentModel, './files': files,
    './encodings': encodings, './languages': { languages: [] }, '../ui/palette': {},
    './transfer': { isTransferring: () => false }, './tabs': tabs,
  }, globals);
  editorCommands.registerEditorCommands();
  const paths = () => [...tabs.allTabIds()].map(id => tabs.listTabs().find(tab => tab.id === id)?.doc.path ?? id);
  const edit = text => tabs.getView().dispatch({ changes: { from: 0, to: tabs.getView().state.doc.length, insert: text } });
  return { files, tabs, commands, reads, alerts, saves, windows, paths, edit };
}

test('startup reuse replaces one pristine blank and keeps the tab identity', async () => {
  const f = fixture();
  const blank = f.files.newUntitled();
  const opening = f.files.openPath('C:/one.txt', { reuseTab: blank });
  await until(() => f.reads.length === 1);
  f.reads[0].finish('loaded');
  assert.equal(await opening, blank);
  assert.equal(f.tabs.listTabs().length, 1);
  assert.equal(blank.state.doc.toString(), 'loaded');
  assert.equal(blank.doc.path, 'C:/one.txt');
  assert.equal(blank.doc.dirty, false);
});

test('body drops capture the original anchor and preserve batch order', async () => {
  const f = fixture();
  const before = f.tabs.openTab('before', { path: 'C:/before.txt' });
  const anchor = f.tabs.openTab('dirty', { dirty: true });
  f.tabs.openTab('after', { path: 'C:/after.txt' });
  f.tabs.activateTab(anchor.id);
  const opening = f.commands.executeCommand('file.open', { paths: ['C:/a.txt', 'C:/b.txt'], drop: true });
  await until(() => f.reads.length === 1);
  f.tabs.activateTab(before.id);
  f.reads[0].finish();
  await until(() => f.reads.length === 2);
  f.reads[1].finish();
  await opening;
  assert.deepEqual(f.paths(), ['C:/before.txt', anchor.id, 'C:/a.txt', 'C:/b.txt', 'C:/after.txt']);
  assert.equal(f.windows.length, 0);
});

test('tabbar placement overrides blank reuse and follows beforeId across reorders', async () => {
  const f = fixture();
  const first = f.tabs.openTab('first', { path: 'C:/first.txt' });
  const blank = f.files.newUntitled();
  const last = f.tabs.openTab('last', { path: 'C:/last.txt' });
  f.tabs.activateTab(blank.id);
  const opening = f.files.openDroppedPaths(['C:/a.txt', 'C:/b.txt'], { index: 2, beforeId: last.id });
  await until(() => f.reads.length === 1);
  f.tabs.moveTab(first.id, 2);
  f.reads[0].finish();
  await until(() => f.reads.length === 2);
  f.reads[1].finish();
  await opening;
  assert.deepEqual(f.paths(), [blank.id, 'C:/a.txt', 'C:/b.txt', 'C:/last.txt', 'C:/first.txt']);
  assert.equal(blank.doc.path, null);
});

test('blank reuse rejects dirty, metadata-dirty, populated and saved empty tabs', async () => {
  for (const info of [{ dirty: true }, { metaDirty: true }, { text: 'text' }, { path: 'C:/empty.txt' }, { path: '' }]) {
    const f = fixture();
    const tab = f.tabs.openTab(info.text ?? '', { path: info.path ?? null, dirty: !!info.dirty });
    if (info.metaDirty) tab.metaDirty = true;
    const opening = f.files.openPath('C:/new.txt', { reuseTab: tab });
    await until(() => f.reads.length === 1);
    f.reads[0].finish();
    const opened = await opening;
    assert.notEqual(opened, tab);
    assert.equal(f.tabs.listTabs().length, 2);
    assert.equal(tab.doc.path, info.path ?? null);
  }
});

test('edits, edit-then-undo, closing and Save As during reads never overwrite the candidate', async () => {
  for (const action of ['edit', 'undo', 'close', 'save']) {
    const f = fixture();
    const blank = f.files.newUntitled();
    const opening = f.files.openPath('C:/new.txt', { reuseTab: blank });
    await until(() => f.reads.length === 1);
    let saving;
    if (action === 'close') f.tabs.closeTab(blank.id);
    else if (action === 'save') saving = f.files.saveTab(blank, true);
    else { f.edit('new text'); if (action === 'undo') f.edit(''); }
    f.reads[0].finish('disk text');
    const opened = await opening;
    assert.notEqual(opened, blank, action);
    assert.equal(blank.state.doc.toString(), action === 'edit' ? 'new text' : '', action);
    if (saving) { f.saves[0]('C:/saved.txt'); await saving; assert.equal(blank.doc.path, 'C:/saved.txt'); }
  }
});

test('failed and cancelled reads leave the blank candidate unchanged', async () => {
  for (const kind of ['io', 'cancelled']) {
    const f = fixture();
    const blank = f.files.newUntitled();
    const opening = f.files.openPath('C:/new.txt', { reuseTab: blank });
    await until(() => f.reads.length === 1);
    f.reads[0].reject(Object.assign(new Error(kind), { kind }));
    assert.equal(await opening, undefined);
    assert.deepEqual([...f.tabs.listTabs()], [blank]);
    assert.equal(blank.doc.path, null);
    assert.equal(blank.state.doc.length, 0);
  }
});

test('a failed first drop keeps the candidate available for the next successful file', async () => {
  const f = fixture();
  const blank = f.files.newUntitled();
  const opening = f.files.openDroppedPaths(['C:/missing.txt', 'C:/next.txt']);
  await until(() => f.reads.length === 1);
  f.reads[0].reject(Object.assign(new Error('missing'), { kind: 'io' }));
  await until(() => f.reads.length === 2);
  assert.equal(blank.doc.path, null);
  f.reads[1].finish('next');
  await opening;
  assert.deepEqual([...f.tabs.listTabs()], [blank]);
  assert.equal(blank.state.doc.toString(), 'next');
});

test('Save As cancellation during a read still invalidates its original reuse snapshot', async () => {
  const f = fixture();
  const blank = f.files.newUntitled();
  const opening = f.files.openPath('C:/new.txt', { reuseTab: blank });
  await until(() => f.reads.length === 1);
  const saving = f.files.saveTab(blank, true);
  f.saves[0](null);
  assert.equal(await saving, false);
  assert.equal(f.files.isReusableUntitled(blank), true);
  f.reads[0].finish();
  assert.notEqual(await opening, blank);
  assert.equal(blank.doc.path, null);
});

test('a path introduced by Save As during reading is activated without overwriting its text', async () => {
  const f = fixture();
  const blank = f.files.newUntitled();
  const opening = f.files.openPath('C:/new.txt', { reuseTab: blank });
  await until(() => f.reads.length === 1);
  f.edit('saved locally');
  const saving = f.files.saveTab(blank, true);
  f.saves[0]('C:/new.txt');
  assert.equal(await saving, true);
  f.reads[0].finish('old disk bytes');
  assert.equal(await opening, blank);
  assert.equal(f.tabs.listTabs().length, 1);
  assert.equal(blank.state.doc.toString(), 'saved locally');
});

test('same-path concurrent drops share one read and duplicate batch paths do not reverse later files', async () => {
  const f = fixture();
  f.files.newUntitled();
  const first = f.files.openDroppedPaths(['C:/a.txt', 'C:/A.txt', 'C:/b.txt']);
  await until(() => f.reads.length === 1);
  const second = f.files.openPath('c:\\A.txt');
  f.reads[0].finish();
  await until(() => f.reads.length === 2);
  f.reads[1].finish();
  await Promise.all([first, second]);
  assert.equal(f.reads.length, 2);
  assert.deepEqual(f.paths(), ['C:/a.txt', 'C:/b.txt']);
});

test('tabbar drops reorder existing paths with new paths once in stable batch order', async () => {
  const f = fixture();
  f.tabs.openTab('a', { path: 'C:/a.txt' });
  const before = f.tabs.openTab('before', { path: 'C:/before.txt' });
  f.tabs.openTab('after', { path: 'C:/after.txt' });
  f.tabs.openTab('c', { path: 'C:/c.txt' });
  const opening = f.files.openDroppedPaths(['C:/c.txt', 'C:/a.txt', 'c:\\C.txt', 'C:/new.txt'], { index: 1, beforeId: before.id });
  await until(() => f.reads.length === 1);
  f.reads[0].finish();
  await opening;
  assert.deepEqual(f.paths(), ['C:/c.txt', 'C:/a.txt', 'C:/new.txt', 'C:/before.txt', 'C:/after.txt']);
});

test('tabbar drops place a shared concurrent read and subsequent existing files at the captured slot', async () => {
  const f = fixture();
  const a = f.tabs.openTab('a', { path: 'C:/a.txt' });
  const target = f.tabs.openTab('target', { path: 'C:/target.txt' });
  const pending = f.files.openPath('C:/pending.txt');
  await until(() => f.reads.length === 1);
  const opening = f.files.openDroppedPaths(['C:/pending.txt', 'C:/a.txt'], { index: 1, beforeId: target.id });
  f.reads[0].finish();
  await Promise.all([pending, opening]);
  assert.equal(f.reads.length, 1);
  assert.deepEqual(f.paths(), ['C:/pending.txt', 'C:/a.txt', 'C:/target.txt']);
  assert.equal(f.tabs.activeTab(), a);
  await f.files.openPath('C:/pending.txt');
  assert.deepEqual(f.paths(), ['C:/pending.txt', 'C:/a.txt', 'C:/target.txt']);
});

test('quit drain spans the whole accepted drop batch while rejecting new drops', async () => {
  const f = fixture();
  f.files.newUntitled();
  const opening = f.commands.executeCommand('file.open', { paths: ['C:/a.txt', 'C:/b.txt'], drop: true });
  await until(() => f.reads.length === 1);
  f.commands.setCommandExecutionBlocked(true);
  let drained = false;
  const draining = f.files.drainFileOperations().then(result => { drained = true; return result; });
  assert.equal(await f.commands.executeCommand('file.open', { paths: ['C:/blocked.txt'], drop: true }), undefined);
  f.reads[0].finish();
  await until(() => f.reads.length === 2);
  assert.equal(drained, false);
  f.reads[1].finish();
  await opening;
  assert.equal(await draining, true);
  assert.deepEqual(f.paths(), ['C:/a.txt', 'C:/b.txt']);
});

test('a placeholder without a document blocks keyboard editing', () => {
  const f = fixture();
  const view = f.tabs.getView();
  assert.equal(view.state.readOnly, true);
  assert.equal(require('@codemirror/commands').insertNewlineAndIndent(view), false);
  const blank = f.files.newUntitled();
  f.tabs.closeTab(blank.id);
  assert.equal(view.state.readOnly, true);
});
