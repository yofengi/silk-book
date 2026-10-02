import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModule } from './test-module.mjs';
import { testDom } from './test-dom.mjs';

const release = (version = '0.2.0') => ({ version, notes: '<script>inert()</script>\nChanges', url: `https://github.com/yofengi/silk-book/releases/tag/v${version}`, asset: { name: `silk-book-${version}-windows-x64-setup.exe`, url: 'https://github.com/yofengi/silk-book/releases/download/update.exe' } });
const transfer = (revision, phase, extra = {}) => ({ revision, taskId: 'download-1', phase, release: release(), source: 'manual', mode: 'download-only', downloadedBytes: 30, totalBytes: 100, error: null, ...extra });
const idle = () => transfer(0, 'idle', { taskId: null, release: null, downloadedBytes: 0, totalBytes: null });
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

async function serviceFixture({ snapshot = idle(), subscription } = {}) {
  const calls = [];
  const values = new Map([['updates.intervalHours', 24], ['updates.lastCheckedAt', 0], ['updates.ignoredVersion', ''], ['updates.autoDownload', false], ['updates.manualMode', 'download-only']]);
  const handlers = new Map();
  const commands = new Map();
  const events = {
    on(type, fn) { const list = handlers.get(type) ?? []; list.push(fn); handlers.set(type, list); return () => {}; },
    emit(type, value) { for (const fn of handlers.get(type) ?? []) fn(value); },
  };
  let blocked = false;
  let current = snapshot;
  let checked;
  let changed;
  let ready;
  let failure;
  const notices = [];
  events.on('updates.ready', (event) => notices.push(event));
  const ipc = {
    async onUpdatesChecked(fn) { checked = fn; calls.push('subscribe-check'); },
    async onUpdateTransfer(fn) { changed = fn; calls.push('subscribe-transfer'); if (subscription) await subscription; },
    async onUpdateReady(fn) { ready = fn; calls.push('subscribe-ready'); },
    async updateInfo() { calls.push('info'); return { currentVersion: '0.1.1', platform: 'Windows x64', repositoryUrl: 'https://github.com/yofengi/silk-book', transfer: current }; },
    async updatesTransfer() { calls.push('snapshot'); return current; },
    async checkUpdates(manual) { calls.push(['check', manual]); return { status: 'available', checkedAt: Date.now(), revision: 1, release: release() }; },
    async downloadUpdate(version, mode) { calls.push(['download', version, mode]); if (failure) throw failure; return transfer(2, 'downloading', { mode }); },
    async installUpdate(taskId) { calls.push(['install', taskId]); if (failure) throw failure; },
    async openUpdateLink(target, version) { calls.push(['open', target, version]); },
  };
  const mod = await loadModule('src/core/updates.ts', {
    '../ipc': { ipc, isIpcError: (e) => !!e?.kind },
    '../i18n': { t: (key) => key },
    './commands': { isCommandExecutionBlocked: () => blocked, registerCommand: (command) => commands.set(command.id, command) },
    './events': { events },
    './settings': { getSetting: (key) => values.get(key), setSetting: (key, value) => { values.set(key, value); events.emit('settings.changed', { key }); }, flushSettings: async () => {} },
  }, { setTimeout: () => 1, clearTimeout() {} });
  mod.startUpdateService();
  await settle();
  return {
    mod, calls, values, notices, commands,
    async state(value) { current = value; changed(value); await settle(); },
    async notice(value) { ready(value); await settle(); },
    async check(value) { checked(value); await settle(); },
    freeze(value) { blocked = value; events.emit('commands.executionChanged', { blocked }); },
    fail(value) { failure = value; },
  };
}

test('shared update snapshots are read only after all native subscriptions are ready', async () => {
  let subscribe;
  const f = await serviceFixture({ subscription: new Promise((resolve) => { subscribe = resolve; }) });
  assert.equal(f.calls.includes('info'), false);
  assert.equal(f.calls.includes('snapshot'), false);
  subscribe();
  await settle();
  assert.equal(f.calls.includes('info'), true);
  assert.equal(f.calls.includes('snapshot'), true);
  f.mod.stopUpdateService();
});

test('progress rejects stale revisions and keeps the package release pinned across newer checks', async () => {
  const f = await serviceFixture();
  await f.state(transfer(4, 'downloading', { downloadedBytes: 65 }));
  await f.state(transfer(3, 'downloading', { downloadedBytes: 20 }));
  assert.equal(f.mod.getUpdateState().transfer.downloadedBytes, 65);
  await f.check({ status: 'available', checkedAt: Date.now(), revision: 2, release: release('0.3.0') });
  assert.equal(f.mod.getUpdateNotification().release.version, '0.2.0');
  assert.equal(f.mod.getUpdateRelease().version, '0.2.0');
});

test('manual download uses the selected mode and never opens the browser or starts installation', async () => {
  const f = await serviceFixture();
  await f.mod.checkForUpdates(true);
  f.values.set('updates.manualMode', 'download-and-install');
  await f.mod.downloadUpdate();
  assert.deepEqual(f.calls.filter(Array.isArray).at(-1), ['download', '0.2.0', 'download-and-install']);
  assert.equal(f.calls.some((call) => Array.isArray(call) && ['install', 'open'].includes(call[0])), false);
});

test('current releases cannot start a hidden download through the command palette', async () => {
  const f = await serviceFixture();
  await f.check({ status: 'current', checkedAt: Date.now(), revision: 1, release: release('0.1.1') });
  assert.equal(f.commands.get('updates.download').when(), false);
  await f.mod.downloadUpdate();
  assert.equal(f.calls.some((call) => Array.isArray(call) && call[0] === 'download'), false);
});

test('a failed transfer retries its pinned package while newer checked versions stay separate', async () => {
  const f = await serviceFixture({ snapshot: transfer(8, 'error', { error: { kind: 'updateNetwork', message: 'offline' } }) });
  await f.check({ status: 'available', checkedAt: Date.now(), revision: 2, release: release('0.3.0') });
  await f.mod.downloadUpdate();
  assert.deepEqual(f.calls.filter(Array.isArray).at(-1), ['download', '0.2.0', 'download-only']);
});

test('ready snapshots do not force a popup or installation, while a targeted notice is delivered once', async () => {
  const f = await serviceFixture({ snapshot: transfer(5, 'ready') });
  assert.equal(f.notices.length, 0);
  await f.notice({ taskId: 'download-1', revision: 5 });
  await f.notice({ taskId: 'download-1', revision: 5 });
  assert.equal(f.notices.length, 1);
  assert.equal(f.calls.some((call) => Array.isArray(call) && call[0] === 'install'), false);
});

test('targeted completion survives command freeze and waits for its revisioned ready state', async () => {
  const f = await serviceFixture();
  f.freeze(true);
  await f.notice({ taskId: 'download-1', revision: 7 });
  await f.state(transfer(7, 'ready', { mode: 'download-and-install' }));
  assert.equal(f.notices.length, 0);
  f.freeze(false);
  assert.equal(f.notices.length, 1);
});

test('a dismissed completion cannot be reopened by snapshots or repeated targeted notices', async () => {
  const f = await serviceFixture();
  await f.state(transfer(8, 'ready'));
  await f.notice({ taskId: 'download-1', revision: 8 });
  await f.state(transfer(9, 'ready'));
  await f.notice({ taskId: 'download-1', revision: 8 });
  await f.notice({ taskId: 'older-task', revision: 7 });
  assert.equal(f.notices.length, 1);
});

test('install retry requires an explicit action and preserves a ready package after native failure', async () => {
  const f = await serviceFixture({ snapshot: transfer(8, 'ready') });
  f.fail({ kind: 'updateInstall', message: 'installer failed' });
  await f.mod.installUpdate();
  assert.equal(f.mod.getUpdateState().transfer.phase, 'ready');
  assert.equal(f.mod.getUpdateState().transferErrorKind, 'updateInstall');
  f.fail(null);
  await f.mod.installUpdate();
  assert.equal(f.calls.filter((call) => Array.isArray(call) && call[0] === 'install').length, 2);
  assert.equal(f.mod.getUpdateState().transferErrorKind, null);
});

test('a restored ready package opens its pinned release page before any new release check', async () => {
  const f = await serviceFixture({ snapshot: transfer(8, 'ready') });
  assert.equal(f.mod.getUpdateState().result, null);
  assert.equal(f.commands.get('updates.release').when(), true);
  await f.commands.get('updates.release').run();
  assert.deepEqual(f.calls.filter(Array.isArray).at(-1), ['open', 'release', '0.2.0']);
});

test('frozen commands block transfer starts, installs and new update settings', async () => {
  const f = await serviceFixture({ snapshot: transfer(8, 'ready') });
  f.freeze(true);
  await f.mod.downloadUpdate();
  await f.mod.installUpdate();
  f.mod.setAutoDownload(true);
  f.mod.setManualUpdateMode('download-and-install');
  assert.equal(f.calls.filter(Array.isArray).length, 0);
  assert.equal(f.values.get('updates.autoDownload'), false);
  assert.equal(f.values.get('updates.manualMode'), 'download-only');
});

test('every window observes automatic progress without issuing its own automatic download', async () => {
  const f = await serviceFixture();
  f.values.set('updates.autoDownload', true);
  await f.state(transfer(1, 'downloading', { source: 'automatic', totalBytes: null }));
  await f.state(transfer(2, 'ready', { source: 'automatic' }));
  assert.equal(f.calls.filter((call) => Array.isArray(call) && ['download', 'install'].includes(call[0])).length, 0);
  assert.equal(f.notices.length, 0);
});

test('native update adapters use fixed commands and receive ready notices only for this webview', async () => {
  const calls = [];
  const subscriptions = [];
  const { tauriIpc } = await loadModule('src/ipc/tauri.ts', {
    '@tauri-apps/api/core': { Channel: class {}, convertFileSrc() {}, invoke: async (...args) => { calls.push(args); } },
    '@tauri-apps/api/window': { Effect: {}, EffectState: {}, Window: class {}, cursorPosition() {}, getAllWindows() {}, getCurrentWindow() {} },
    '@tauri-apps/api/webviewWindow': { getCurrentWebviewWindow: () => ({ listen: async (name, fn) => subscriptions.push({ name, fn }) }) },
    '@tauri-apps/plugin-opener': { openUrl() {}, revealItemInDir() {} },
    '@tauri-apps/api/event': { emitTo() {} },
    '@tauri-apps/plugin-dialog': { confirm() {}, open() {}, save() {} },
    '../i18n': { productName: () => 'silk book' },
  });
  await tauriIpc.updatesTransfer();
  await tauriIpc.downloadUpdate('0.2.0', 'download-only');
  await tauriIpc.installUpdate('verified-package');
  assert.equal(JSON.stringify(calls), JSON.stringify([
    ['updates_transfer'], ['updates_download', { version: '0.2.0', mode: 'download-only' }], ['updates_install', { taskId: 'verified-package' }],
  ]));
  const observed = [];
  await tauriIpc.onUpdateTransfer((value) => observed.push(value));
  await tauriIpc.onUpdateReady((value) => observed.push(value));
  assert.deepEqual(subscriptions.map(({ name }) => name), ['updates-state-changed', 'updates-ready']);
  subscriptions[1].fn({ payload: { taskId: 'verified-package', revision: 8 } });
  assert.deepEqual(observed, [{ taskId: 'verified-package', revision: 8 }]);
});

test('topbar progress patches persistent popup nodes and does not disturb focused actions', async () => {
  const dom = testDom();
  const create = dom.document.createElement;
  dom.document.createElement = (tag) => Object.assign(create(tag), { dataset: {} });
  const handlers = new Map();
  const commands = new Map();
  const state = { info: { platform: 'Windows x64' }, result: { status: 'available', release: release() }, transfer: transfer(1, 'downloading'), errorKind: null, transferErrorKind: null };
  const mod = await loadModule('src/ui/updates.ts', {
    './updates.css': {},
    '../core/commands': { registerCommand: (command) => commands.set(command.id, command), isCommandExecutionBlocked: () => false, async executeCommand(id) { return commands.get(id)?.run(); } },
    '../core/events': { events: { on(type, fn) { handlers.set(type, fn); return () => {}; } } },
    '../core/updates': { getUpdateNotification: () => state.result, getUpdateState: () => state, getUpdateRelease: () => state.transfer.release },
    '../i18n': { t: (key, params) => `${key}${params ? JSON.stringify(params) : ''}`, getLocale: () => 'en' },
  }, dom);
  const button = mod.createUpdateButton();
  dom.document.body.append(button);
  button.click();
  const panel = dom.document.body.children.find((child) => child.getAttribute('role') === 'dialog');
  const descendants = (node) => [node, ...node.children.flatMap(descendants)];
  const notes = descendants(panel).find((node) => node.className === 'update-notes');
  const action = descendants(panel).find((node) => node.classList.contains('update-action') && !node.hidden && !node.disabled);
  action.focus();
  state.transfer = transfer(2, 'downloading', { downloadedBytes: 45 });
  handlers.get('updates.changed')();
  assert.equal(dom.document.activeElement, action);
  assert.equal(action.isConnected, true);
  assert.equal(descendants(panel).find((node) => node.className === 'update-notes'), notes);
  assert.equal(notes.textContent, release().notes);
  assert.match(button.getAttribute('aria-label'), /45/);
  const progress = descendants(panel).find((node) => node.tagName === 'progress');
  assert.equal(progress.getAttribute('value'), '45');
  state.transfer = transfer(3, 'downloading', { totalBytes: null });
  handlers.get('updates.changed')();
  assert.equal(progress.getAttribute('value'), null);
});
