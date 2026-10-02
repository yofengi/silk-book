// Run the actual transfer module twice, as independent WebView modules.
/* global console, setTimeout, clearTimeout, TextEncoder, TextDecoder, process */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { Text } from '@codemirror/state';

const require = createRequire(import.meta.url);
function load(file, imports) {
  const module = { exports: {} };
  const code = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, {
    module, exports: module.exports, require: (name) => name in imports ? imports[name] : require(name),
    console: { warn() {}, error() {} }, setTimeout: (fn) => setTimeout(fn, 0), clearTimeout,
    TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, DataView, alert() {},
  }, { filename: file });
  return module.exports;
}

const draft = () => ({
  id: 'source', state: { doc: Text.of(['中文 draft 🚀', 'second line']) },
  doc: { path: 'C:\\same.txt', encoding: 'UTF-16BE', eol: 'MIXED', eolMap: 'C', hasBom: true,
    readEncoding: 'UTF-8', malformed: true, size: 32, tier: 'Normal', dirty: true },
  flags: { minimap: false, wordCompletion: true, lineWrap: false }, languageId: 'typescript',
});

function fixture() {
  const transfers = new Map(); const listeners = new Map(); const calls = [];
  const windows = {};
  function makeWindow(label, tabs) {
    const order = tabs.map((tab) => tab.id); let seq = 0; let blocked = false;
    const listenersForWindow = new Map(); listeners.set(label, listenersForWindow);
    const hooks = { applyLanguage: async (tab, id) => { tab.languageId = id; } };
    const ipc = {
      bus: { label, on: async (name, fn) => {
        calls.push(`${label}:listen`); listenersForWindow.set(name, fn);
      } },
      transferPut: async (body) => {
        const token = `token-${transfers.size + 1}`;
        transfers.set(token, { source: label, body }); calls.push('put'); return token;
      },
      transferSend: async (token, target, placement) => {
        const transfer = transfers.get(token);
        assert.equal(transfer.source, label); assert.ok(windows[target]);
        transfer.target = target; calls.push(`send:${target}`);
        const listener = listeners.get(target).get('tab-transfer-offered');
        assert.ok(listener, 'destination subscribed before accepting offers');
        listener({ token, source: label, placement });
      },
      transferTake: async (token) => {
        const transfer = transfers.get(token);
        assert.equal(transfer.target, label); assert.ok(transfer.body);
        const body = transfer.body; delete transfer.body; calls.push('take'); return body;
      },
      transferAccept: async (token) => {
        const transfer = transfers.get(token);
        assert.equal(transfer.target, label); assert.equal(transfer.body, undefined);
        assert.ok(tabs.find((tab) => tab.restored), 'selection restored before ACK');
        transfer.accepted = true; calls.push('ack');
      },
      transferReject: async (token) => {
        const transfer = transfers.get(token);
        if (transfer) assert.equal(transfer.target, label);
        transfers.delete(token); calls.push('reject');
      },
      transferStatus: async (token) => {
        const transfer = transfers.get(token); calls.push('status');
        return transfer ? { state: transfer.accepted ? 'accepted' : transfer.body ? 'pending' : 'taken', target: transfer.target }
          : { state: 'missing' };
      },
      transferCancel: async (token) => { transfers.delete(token); calls.push('cancel'); },
      windowOpen: async () => { calls.push('new-window'); throw Error('unexpected new window'); },
      window: { close: async () => { calls.push('close-window'); }, focus: async () => { calls.push('focus'); } },
    };
    const tabApi = {
      listTabs: () => tabs, allTabIds: () => [...order], tabText: (tab) => tab.state.doc.toString(),
      viewSnapshot: () => ({ anchor: 1, head: 4, scrollPos: 0 }),
      closeTab: (id) => {
        assert.ok(calls.includes('ack'), 'source removal requires ACK');
        calls.push('remove-source'); tabs.splice(tabs.findIndex((tab) => tab.id === id), 1);
        order.splice(order.indexOf(id), 1);
      },
      openTab: (text, doc, flags) => {
        const tab = { id: `${label}-tab-${++seq}`, state: { doc: Text.of(text.split('\n')) },
          doc: { ...doc }, flags: { ...flags }, languageId: 'plaintext' };
        tabs.push(tab); order.push(tab.id); calls.push('open-target'); return tab;
      },
      applyLanguage: (tab, id) => hooks.applyLanguage(tab, id),
      markTransferredDirty: (tab) => { tab.doc.dirty = true; tab.metaDirty = true; },
      activateTab: (id) => { calls.push(`activate:${id}`); },
      moveTab: (id, index) => { order.splice(order.indexOf(id), 1); order.splice(Math.max(0, Math.min(index, order.length)), 0, id); },
      restoreViewSnapshot: (tab, snap) => { tab.restored = { ...snap }; calls.push('restore'); },
    };
    const module = load('src/editor/transfer.ts', {
      '../core/events': { events: { emit() {} } },
      '../core/commands': { isCommandExecutionBlocked: () => blocked },
      '../core/settings': { getSetting: () => false }, '../i18n': { t: (key) => key },
      '../ipc': { ipc, errorMessage: (error) => error.message }, './tabs': tabApi,
    });
    return windows[label] = { module, ipc, tabs, order, hooks, block: (value) => { blocked = value; } };
  }
  const source = makeWindow('main', [draft()]);
  const target = makeWindow('win-1', [{ ...draft(), id: 'left', state: { doc: Text.of(['existing dirty content']) } },
    { ...draft(), id: 'right' }]);
  return { source, target, transfers, calls };
}

const failures = [];
async function check(name, fn) {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.stack}`); }
}

await check('existing-window merge restores metadata and selection between existing tabs, then removes source', async () => {
  const f = fixture(); const original = draft();
  await f.target.module.installIncomingTransferListener();
  assert.equal(await f.source.module.moveTabToExistingWindow('source', 'win-1', { index: 1, beforeId: 'right' }), true);
  assert.equal(f.calls.includes('new-window'), false); assert.equal(f.source.tabs.length, 0);
  const moved = f.target.tabs[2]; assert.deepEqual(f.target.order, ['left', moved.id, 'right']);
  assert.equal(moved.state.doc.toString(), original.state.doc.toString());
  assert.deepEqual(moved.doc, original.doc); assert.deepEqual(moved.flags, original.flags);
  assert.equal(moved.languageId, original.languageId); assert.equal(moved.metaDirty, true);
  assert.deepEqual(moved.restored, { anchor: 1, head: 4, scrollPos: 0 });
  assert.equal(f.target.tabs[0].state.doc.toString(), 'existing dirty content');
  assert.ok(f.calls.indexOf('restore') < f.calls.indexOf('ack'));
  assert.ok(f.calls.indexOf('ack') < f.calls.indexOf('remove-source'));
});
await check('insertion follows the referenced neighbour if order changes during language loading', async () => {
  const f = fixture(); await f.target.module.installIncomingTransferListener();
  f.target.hooks.applyLanguage = async (tab, id) => { f.target.order.unshift('special:settings'); tab.languageId = id; };
  assert.equal(await f.source.module.moveTabToExistingWindow('source', 'win-1', { index: 1, beforeId: 'right' }), true);
  assert.deepEqual(f.target.order, ['special:settings', 'left', f.target.tabs[2].id, 'right']);
});
await check('existing-window offer failure preserves original dirty document and clears staged bytes', async () => {
  const f = fixture(); f.source.ipc.transferSend = async () => { throw Error('target closed'); };
  assert.equal(await f.source.module.moveTabToExistingWindow('source', 'win-1', { index: 0 }), false);
  assert.equal(f.source.tabs[0].state.doc.toString(), draft().state.doc.toString());
  assert.equal(f.transfers.size, 0); assert.equal(f.calls.includes('remove-source'), false);
});
await check('closing recipient rejects promptly and never ACKs or removes source', async () => {
  const f = fixture(); await f.target.module.installIncomingTransferListener();
  f.target.module.setTransferClosing(true);
  assert.equal(await f.source.module.moveTabToExistingWindow('source', 'win-1', { index: 0 }), false);
  assert.equal(f.source.tabs.length, 1); assert.equal(f.target.tabs.length, 2);
  assert.ok(f.calls.includes('reject')); assert.equal(f.calls.includes('ack'), false);
});
await check('quit command freeze also rejects incoming offers without changing target tabs', async () => {
  const f = fixture(); await f.target.module.installIncomingTransferListener(); f.target.block(true);
  assert.equal(await f.source.module.moveTabToExistingWindow('source', 'win-1'), false);
  assert.equal(f.target.tabs.length, 2); assert.equal(f.source.tabs.length, 1);
});
await check('source edits during target hydration preserve the newer source draft', async () => {
  const f = fixture(); await f.target.module.installIncomingTransferListener();
  f.target.hooks.applyLanguage = async (tab, id) => { f.source.tabs[0].state.doc = Text.of(['newer draft']); tab.languageId = id; };
  assert.equal(await f.source.module.moveTabToExistingWindow('source', 'win-1'), true);
  assert.equal(f.source.tabs[0].state.doc.toString(), 'newer draft');
  assert.equal(f.target.tabs[2].state.doc.toString(), draft().state.doc.toString());
});
await check('recipient removed while language loads cannot ACK and source remains', async () => {
  const f = fixture(); await f.target.module.installIncomingTransferListener();
  f.target.hooks.applyLanguage = async (tab) => { f.target.tabs.splice(f.target.tabs.indexOf(tab), 1); };
  assert.equal(await f.source.module.moveTabToExistingWindow('source', 'win-1'), false);
  assert.equal(f.calls.includes('ack'), false); assert.equal(f.source.tabs.length, 1);
});
await check('incoming offer listener installs once even with concurrent startup requests', async () => {
  const f = fixture(); await Promise.all([f.target.module.installIncomingTransferListener(), f.target.module.installIncomingTransferListener()]);
  assert.equal(f.calls.filter((call) => call === 'win-1:listen').length, 1);
});

if (failures.length) process.exitCode = 1;
